import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";

const STOCK_UNIT_OPTIONS = ["KG", "G", "L", "ML", "UNIDAD", "PAQUETE"];
const STOCK_AI_PATH = "/api/dashboard/stock/recipe-ai";
const STOCK_AI_TIMEOUT_MS = 25000;
const EPSILON = 0.0001;

function stripDiacritics(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeUppercaseText(value) {
  return stripDiacritics(value).toLocaleUpperCase("es-AR");
}

function normalizeStockNameForStorage(value) {
  const text = normalizeUppercaseText(value).trim();
  return text || null;
}

function normalizeTextWithoutAccents(value) {
  return stripDiacritics(value);
}

function normalizeRecipeNameForStorage(value) {
  const text = normalizeTextWithoutAccents(value).trim();
  return text || null;
}

function normalizeStockUnit(value) {
  const text = normalizeUppercaseText(value).trim();
  if (!text) return "UNIDAD";
  if (["KG", "KILO", "KILO", "KILOGRAMO", "KILOGRAMOS"].includes(text)) return "KG";
  if (["G", "GR", "GRAMO", "GRAMOS"].includes(text)) return "G";
  if (["L", "LT", "LITRO", "LITROS"].includes(text)) return "L";
  if (["ML", "MILILITRO", "MILILITROS"].includes(text)) return "ML";
  if (["UNIDAD", "UNIDADES", "U"].includes(text)) return "UNIDAD";
  if (["PAQUETE", "PAQUETES", "PACK"].includes(text)) return "PAQUETE";
  return STOCK_UNIT_OPTIONS.includes(text) ? text : "UNIDAD";
}

function normalizeDecimalInput(value) {
  const raw = String(value ?? "").replace(",", ".");
  let out = "";
  let seenDot = false;
  for (const char of raw) {
    if (/\d/.test(char)) {
      out += char;
      continue;
    }
    if (char === "." && !seenDot) {
      out += char;
      seenDot = true;
    }
  }
  return out;
}

function normalizeNumericInputByUnit(value, unit) {
  return normalizeStockUnit(unit) === "UNIDAD" ? String(value ?? "").replace(/[^\d]/g, "") : normalizeDecimalInput(value);
}

function parseQuantityValue(value, fallback = 0) {
  const normalized = normalizeDecimalInput(value);
  if (!normalized || normalized === ".") return fallback;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.round(parsed * 1000) / 1000;
}

function parseQuantityValueByUnit(value, unit, fallback = 0) {
  const parsed = parseQuantityValue(value, fallback);
  if (normalizeStockUnit(unit) === "UNIDAD") {
    return Math.max(0, Math.floor(parsed + EPSILON));
  }
  return parsed;
}

function formatQuantity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  if (Math.abs(numeric - Math.round(numeric)) < EPSILON) return String(Math.round(numeric));
  return numeric.toFixed(3).replace(/\.?0+$/, "");
}

function formatStockDisplay(value, unit) {
  return `${formatQuantity(value)} ${normalizeStockUnit(unit)}`;
}

function convertQuantityBetweenUnits(quantity, fromUnit, toUnit) {
  const amount = Number(quantity);
  const from = normalizeStockUnit(fromUnit);
  const to = normalizeStockUnit(toUnit);
  if (!Number.isFinite(amount)) return null;
  if (from === to) return amount;
  if (from === "KG" && to === "G") return amount * 1000;
  if (from === "G" && to === "KG") return amount / 1000;
  if (from === "L" && to === "ML") return amount * 1000;
  if (from === "ML" && to === "L") return amount / 1000;
  return null;
}

function emptyRecipeForm() {
  return {
    name: "",
    preparation: "",
    ingredientInput: "",
    ingredientQuantity: "",
    ingredientUnit: "UNIDAD",
    ingredients: [],
    aiText: ""
  };
}

function normalizeRecipeRows(rows) {
  return (rows || []).map((row) => ({
    ...row,
    ingredients: (Array.isArray(row?.stock_recipe_ingredients) ? row.stock_recipe_ingredients : [])
      .map((ingredient) => ({
        id: ingredient.id,
        ingredient_name: normalizeStockNameForStorage(ingredient.ingredient_name) || "",
        quantity: parseQuantityValueByUnit(ingredient.quantity, ingredient.unit, 1),
        unit: normalizeStockUnit(ingredient.unit)
      }))
      .filter((ingredient) => ingredient.ingredient_name)
      .sort((a, b) => a.ingredient_name.localeCompare(b.ingredient_name, "es", { sensitivity: "base" }))
  }));
}

function stockAiBaseAllowedFromBrowser(baseRaw) {
  const raw = String(baseRaw || "").trim();
  if (!raw) return false;
  if (!window.isSecureContext) return true;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (url.protocol !== "http:") return true;
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

function buildStockAiCandidates() {
  const candidates = [];
  const pushCandidate = (baseRaw) => {
    const base = String(baseRaw || "").trim().replace(/\/$/, "");
    if (!base || !stockAiBaseAllowedFromBrowser(base)) return;
    candidates.push(`${base}${STOCK_AI_PATH}`);
  };
  const origin = window.location.origin.replace(/\/$/, "");
  const configuredBase = String(import.meta.env.VITE_STOCK_AI_BASE_URL || import.meta.env.VITE_MESA_API_BASE_URL || "").trim();
  const configuredBackendPort = String(import.meta.env.VITE_BACKEND_PORT || "").trim() || "3000";
  pushCandidate(origin);
  pushCandidate(configuredBase);
  const hostBackendPort = `${window.location.protocol}//${window.location.hostname}:${configuredBackendPort}`;
  pushCandidate(hostBackendPort);
  return [...new Set(candidates)];
}

async function fetchWithTimeout(url, options, timeoutMs = STOCK_AI_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function fallbackRecipeNameFromText(text) {
  const firstLine = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 80) : "";
}

export default function StockManagerPanel({ restaurantId }) {
  const [activeSection, setActiveSection] = useState("stock");
  const [stockItems, setStockItems] = useState([]);
  const [stockDraftById, setStockDraftById] = useState({});
  const [stockUnitDraftById, setStockUnitDraftById] = useState({});
  const [stockNameDraftById, setStockNameDraftById] = useState({});
  /** Solo la fila con este id muestra el input de nombre; el resto usa un “entry” solo lectura. */
  const [editingStockNameId, setEditingStockNameId] = useState(null);
  const [stockUnitVisibility, setStockUnitVisibility] = useState(() =>
    Object.fromEntries(STOCK_UNIT_OPTIONS.map((unit) => [unit, true]))
  );
  const [recipeUseCountById, setRecipeUseCountById] = useState({});
  const [loadingStock, setLoadingStock] = useState(true);
  const [loadingRecipes, setLoadingRecipes] = useState(true);
  const [stockError, setStockError] = useState("");
  const [stockFlash, setStockFlash] = useState("");
  const [recipeError, setRecipeError] = useState("");
  const [recipeFlash, setRecipeFlash] = useState("");
  const [savingStockId, setSavingStockId] = useState(null);
  const [usingRecipeId, setUsingRecipeId] = useState(null);
  const [newStockName, setNewStockName] = useState("");
  const [newStockValue, setNewStockValue] = useState("");
  const [newStockUnit, setNewStockUnit] = useState("UNIDAD");
  const [addingStock, setAddingStock] = useState(false);
  const [recipes, setRecipes] = useState([]);
  const [recipeSearchQuery, setRecipeSearchQuery] = useState("");
  const [recipeForm, setRecipeForm] = useState(emptyRecipeForm);
  const [editingRecipeId, setEditingRecipeId] = useState(null);
  const [savingRecipe, setSavingRecipe] = useState(false);
  const [deletingRecipeId, setDeletingRecipeId] = useState(null);
  const [showAiAssistant, setShowAiAssistant] = useState(false);
  const [analyzingRecipeText, setAnalyzingRecipeText] = useState(false);

  const stockByName = useMemo(() => {
    const map = new Map();
    for (const item of stockItems) {
      const key = normalizeStockNameForStorage(item.name);
      if (key) map.set(key, item);
    }
    return map;
  }, [stockItems]);

  const visibleStockItems = useMemo(
    () => stockItems.filter((item) => stockUnitVisibility[normalizeStockUnit(item.unit)] !== false),
    [stockItems, stockUnitVisibility]
  );

  const recipesForUse = useMemo(() => {
    const query = normalizeTextWithoutAccents(String(recipeSearchQuery || "")).trim().toLocaleLowerCase("es-AR");
    if (!query) return recipes;
    return recipes.filter((recipe) => {
      const haystack = [
        recipe.name || "",
        recipe.preparation || "",
        ...(Array.isArray(recipe.ingredients)
          ? recipe.ingredients.map(
              (ingredient) =>
                `${ingredient.ingredient_name} ${formatQuantity(ingredient.quantity)} ${normalizeStockUnit(ingredient.unit)}`
            )
          : [])
      ]
        .join(" ")
        .toLocaleLowerCase("es-AR");
      return normalizeTextWithoutAccents(haystack).includes(query);
    });
  }, [recipes, recipeSearchQuery]);

  useEffect(() => {
    if (!restaurantId) {
      setStockItems([]);
      setRecipes([]);
      setLoadingStock(false);
      setLoadingRecipes(false);
      setEditingStockNameId(null);
      return;
    }

    setEditingStockNameId(null);

    let cancelled = false;

    async function loadStockItems() {
      setLoadingStock(true);
      const { data, error } = await supabase
        .from("stock_items")
        .select("id, name, current_stock, unit, updated_at")
        .eq("restaurant_id", restaurantId)
        .order("name", { ascending: true });
      if (cancelled) return;
      if (error) {
        setStockError(`No se pudo cargar el stock: ${error.message}`);
        setStockItems([]);
        setStockDraftById({});
        setStockUnitDraftById({});
        setStockNameDraftById({});
        setLoadingStock(false);
        return;
      }
      const items = data || [];
      setStockItems(items);
      setStockDraftById(
        Object.fromEntries(
          items.map((item) => [item.id, formatQuantity(parseQuantityValueByUnit(item.current_stock, item.unit, 0))])
        )
      );
      setStockUnitDraftById(
        Object.fromEntries(items.map((item) => [item.id, normalizeStockUnit(item.unit)]))
      );
      setStockNameDraftById(
        Object.fromEntries(items.map((item) => [item.id, normalizeUppercaseText(item.name || "")]))
      );
      setLoadingStock(false);
    }

    async function loadRecipes() {
      setLoadingRecipes(true);
      const { data, error } = await supabase
        .from("stock_recipes")
        .select("id, name, preparation, stock_recipe_ingredients(id, ingredient_name, quantity, unit)")
        .eq("restaurant_id", restaurantId)
        .order("name", { ascending: true });
      if (cancelled) return;
      if (error) {
        setRecipeError(`No se pudo cargar el recetario: ${error.message}`);
        setRecipes([]);
        setLoadingRecipes(false);
        return;
      }
      const normalized = normalizeRecipeRows(data);
      setRecipes(normalized);
      setRecipeUseCountById((prev) => {
        const next = { ...prev };
        for (const recipe of normalized) {
          if (!next[recipe.id]) next[recipe.id] = 1;
        }
        return next;
      });
      setLoadingRecipes(false);
    }

    void loadStockItems();
    void loadRecipes();

    return () => {
      cancelled = true;
    };
  }, [restaurantId]);

  function updateRecipeForm(patch) {
    setRecipeForm((prev) => ({ ...prev, ...patch }));
  }

  function resetRecipeForm() {
    setEditingRecipeId(null);
    setRecipeForm(emptyRecipeForm());
    setShowAiAssistant(false);
  }

  function addIngredientToRecipeForm() {
    const ingredientName = normalizeStockNameForStorage(recipeForm.ingredientInput);
    const quantity = parseQuantityValueByUnit(recipeForm.ingredientQuantity, recipeForm.ingredientUnit, 1);
    const unit = normalizeStockUnit(recipeForm.ingredientUnit);
    if (!ingredientName) return;
    const nextIngredients = recipeForm.ingredients.filter((ingredient) => ingredient.ingredient_name !== ingredientName);
    nextIngredients.push({ ingredient_name: ingredientName, quantity, unit });

    updateRecipeForm({
      ingredientInput: "",
      ingredientQuantity: "",
      ingredientUnit: recipeForm.ingredientUnit,
      ingredients: nextIngredients.sort((a, b) =>
        a.ingredient_name.localeCompare(b.ingredient_name, "es", { sensitivity: "base" })
      )
    });
  }

  function removeIngredientFromRecipeForm(ingredientName, unit, quantity) {
    updateRecipeForm({
      ingredients: recipeForm.ingredients.filter(
        (ingredient) =>
          !(
            ingredient.ingredient_name === ingredientName &&
            ingredient.unit === unit &&
            Math.abs(Number(ingredient.quantity) - Number(quantity)) < EPSILON
          )
      )
    });
  }

  async function refreshRecipes() {
    if (!restaurantId) return;
    const { data, error } = await supabase
      .from("stock_recipes")
      .select("id, name, preparation, stock_recipe_ingredients(id, ingredient_name, quantity, unit)")
      .eq("restaurant_id", restaurantId)
      .order("name", { ascending: true });
    if (error) throw error;
    const normalized = normalizeRecipeRows(data);
    setRecipes(normalized);
    setRecipeUseCountById((prev) => {
      const next = { ...prev };
      for (const recipe of normalized) {
        if (!next[recipe.id]) next[recipe.id] = 1;
      }
      return next;
    });
  }

  async function addStockItem() {
    const name = normalizeStockNameForStorage(newStockName);
    const currentStock = parseQuantityValueByUnit(newStockValue, newStockUnit, 0);
    const unit = normalizeStockUnit(newStockUnit);
    if (!restaurantId) {
      setStockError("No hay restaurante cargado para guardar stock.");
      return;
    }
    if (!name) {
      setStockError("Escribí un ingrediente para agregar al stock.");
      return;
    }
    if (stockByName.has(name)) {
      setStockError(`El ingrediente ${name} ya existe en stock. No se permiten duplicados por tildes o formato.`);
      return;
    }
    setStockError("");
    setStockFlash("");
    setAddingStock(true);
    const { data, error } = await supabase
      .from("stock_items")
      .insert({
        restaurant_id: restaurantId,
        name,
        current_stock: currentStock,
        unit,
        updated_at: new Date().toISOString()
      })
      .select("id, name, current_stock, unit, updated_at")
      .single();
    setAddingStock(false);
    if (error) {
      setStockError(`No se pudo agregar el ingrediente: ${error.message}`);
      return;
    }
    const nextItems = [...stockItems, data].sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), "es", { sensitivity: "base" })
    );
    setStockItems(nextItems);
    setStockDraftById((prev) => ({
      ...prev,
      [data.id]: formatQuantity(parseQuantityValueByUnit(data.current_stock, data.unit, 0))
    }));
    setStockUnitDraftById((prev) => ({ ...prev, [data.id]: normalizeStockUnit(data.unit) }));
    setStockNameDraftById((prev) => ({ ...prev, [data.id]: normalizeUppercaseText(data.name || "") }));
    setNewStockName("");
    setNewStockValue("");
    setNewStockUnit("UNIDAD");
    setStockFlash(`${name} agregado al stock en ${unit}.`);
  }

  async function saveStockItemRow(item) {
    const draftUnit = stockUnitDraftById[item.id] ?? normalizeStockUnit(item.unit);
    const draftValue =
      stockDraftById[item.id] ??
      formatQuantity(parseQuantityValueByUnit(item.current_stock, draftUnit, 0));
    const currentStock = parseQuantityValueByUnit(draftValue, draftUnit, 0);
    const unit = normalizeStockUnit(draftUnit);
    const nameRaw = stockNameDraftById[item.id] ?? item.name ?? "";
    const normalizedName = normalizeStockNameForStorage(nameRaw);
    if (!normalizedName) {
      setStockError("El nombre del ingrediente no puede quedar vacío.");
      return;
    }
    const previousNameNorm = normalizeStockNameForStorage(item.name);
    if (normalizedName !== previousNameNorm) {
      const conflict = stockItems.find(
        (row) => row.id !== item.id && normalizeStockNameForStorage(row.name) === normalizedName
      );
      if (conflict) {
        setStockError(
          `Ya existe un ingrediente llamado ${normalizedName}. Cambiá el nombre o unificá el stock.`
        );
        return;
      }
    }
    const currentValueDb = parseQuantityValueByUnit(item.current_stock, item.unit, 0);
    const qtyUnchanged =
      Math.abs(currentStock - currentValueDb) < EPSILON &&
      normalizeStockUnit(unit) === normalizeStockUnit(item.unit);
    const nameUnchanged = normalizedName === previousNameNorm;
    if (qtyUnchanged && nameUnchanged) return;

    setStockError("");
    setStockFlash("");
    setSavingStockId(item.id);
    const patch = {
      current_stock: currentStock,
      unit,
      updated_at: new Date().toISOString()
    };
    if (!nameUnchanged) patch.name = normalizedName;
    const { data, error } = await supabase
      .from("stock_items")
      .update(patch)
      .eq("id", item.id)
      .select("id, name, current_stock, unit, updated_at")
      .single();
    setSavingStockId(null);
    if (error) {
      if (error.code === "23505") {
        setStockError(
          `Ya existe un ingrediente con el nombre ${normalizedName} en este restaurante. Elegí otro nombre.`
        );
      } else {
        setStockError(`No se pudo actualizar ${item.name}: ${error.message}`);
      }
      return;
    }
    setStockItems((prev) => prev.map((row) => (row.id === item.id ? data : row)));
    setStockDraftById((prev) => ({ ...prev, [item.id]: formatQuantity(currentStock) }));
    setStockUnitDraftById((prev) => ({ ...prev, [item.id]: unit }));
    setStockNameDraftById((prev) => ({ ...prev, [item.id]: normalizeUppercaseText(data.name || "") }));
    setEditingStockNameId((prev) => (prev === item.id ? null : prev));
    const displayName = data.name || normalizedName;
    let flash = `${displayName}: stock actualizado a ${formatQuantity(currentStock)} ${normalizeStockUnit(unit)}.`;
    if (!nameUnchanged && qtyUnchanged) flash = `Ingrediente renombrado a ${displayName}.`;
    else if (!nameUnchanged && !qtyUnchanged) {
      flash = `${displayName}: nombre y stock actualizados (${formatQuantity(currentStock)} ${normalizeStockUnit(unit)}).`;
    }
    setStockFlash(flash);
  }

  function adjustStockDraft(item, delta) {
    const draftUnit = stockUnitDraftById[item.id] ?? normalizeStockUnit(item.unit);
    const currentDraftValue = parseQuantityValueByUnit(
      stockDraftById[item.id] ?? formatQuantity(parseQuantityValueByUnit(item.current_stock, draftUnit, 0)),
      draftUnit,
      0
    );
    const nextValue = Math.max(0, currentDraftValue + delta);
    setStockDraftById((prev) => ({
      ...prev,
      [item.id]: formatQuantity(parseQuantityValueByUnit(nextValue, draftUnit, 0))
    }));
  }

  async function deleteStockItem(item) {
    if (!window.confirm(`¿Eliminar ${item.name} del stock?`)) return;
    setStockError("");
    setStockFlash("");
    setSavingStockId(item.id);
    const { error } = await supabase.from("stock_items").delete().eq("id", item.id);
    setSavingStockId(null);
    if (error) {
      setStockError(`No se pudo eliminar ${item.name}: ${error.message}`);
      return;
    }
    setStockItems((prev) => prev.filter((row) => row.id !== item.id));
    setStockDraftById((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    setStockUnitDraftById((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    setStockNameDraftById((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    setEditingStockNameId((prev) => (prev === item.id ? null : prev));
    setStockFlash(`${item.name} eliminado del stock.`);
  }

  function startEditingRecipe(recipe) {
    setEditingRecipeId(recipe.id);
    setRecipeError("");
    setRecipeFlash("");
    setRecipeForm({
      name: normalizeTextWithoutAccents(recipe.name || ""),
      preparation: recipe.preparation || "",
      ingredientInput: "",
      ingredientQuantity: "",
      ingredientUnit: "UNIDAD",
      ingredients: recipe.ingredients.map((ingredient) => ({
        ingredient_name: ingredient.ingredient_name,
        quantity: parseQuantityValueByUnit(ingredient.quantity, ingredient.unit, 1),
        unit: normalizeStockUnit(ingredient.unit)
      })),
      aiText: ""
    });
    setShowAiAssistant(false);
    setActiveSection("recipes");
  }

  async function saveRecipe() {
    if (!restaurantId) {
      setRecipeError("No hay restaurante cargado para guardar recetas.");
      return;
    }
    const name = normalizeRecipeNameForStorage(recipeForm.name);
    const preparation = String(recipeForm.preparation || "").trim();
    const ingredients = recipeForm.ingredients
      .map((ingredient) => ({
        ingredient_name: normalizeStockNameForStorage(ingredient.ingredient_name),
        quantity: parseQuantityValueByUnit(ingredient.quantity, ingredient.unit, 1),
        unit: normalizeStockUnit(ingredient.unit)
      }))
      .filter((ingredient) => ingredient.ingredient_name)
      .reduce((acc, ingredient) => {
        const existingIndex = acc.findIndex((entry) => entry.ingredient_name === ingredient.ingredient_name);
        if (existingIndex >= 0) acc[existingIndex] = ingredient;
        else acc.push(ingredient);
        return acc;
      }, []);

    if (!name) {
      setRecipeError("Escribí el nombre de la receta.");
      return;
    }
    const duplicateRecipe = recipes.find(
      (recipe) => normalizeRecipeNameForStorage(recipe.name) === name && recipe.id !== editingRecipeId
    );
    if (duplicateRecipe) {
      setRecipeError(`La receta ${name} ya existe. No se permiten duplicados por tildes o formato.`);
      return;
    }

    setRecipeError("");
    setRecipeFlash("");
    setSavingRecipe(true);

    try {
      let recipeId = editingRecipeId;
      const missingStockIngredients = ingredients.filter(
        (ingredient) => !stockByName.has(normalizeStockNameForStorage(ingredient.ingredient_name))
      );

      if (editingRecipeId) {
        const { error: updateError } = await supabase
          .from("stock_recipes")
          .update({
            name,
            preparation: preparation || null,
            updated_at: new Date().toISOString()
          })
          .eq("id", editingRecipeId);
        if (updateError) throw updateError;

        const { error: deleteIngredientsError } = await supabase
          .from("stock_recipe_ingredients")
          .delete()
          .eq("recipe_id", editingRecipeId);
        if (deleteIngredientsError) throw deleteIngredientsError;
      } else {
        const { data, error: insertError } = await supabase
          .from("stock_recipes")
          .insert({
            restaurant_id: restaurantId,
            name,
            preparation: preparation || null,
            updated_at: new Date().toISOString()
          })
          .select("id")
          .single();
        if (insertError) throw insertError;
        recipeId = data.id;
      }

      if (ingredients.length > 0) {
        const { error: ingredientsError } = await supabase.from("stock_recipe_ingredients").insert(
          ingredients.map((ingredient) => ({
            recipe_id: recipeId,
            ingredient_name: ingredient.ingredient_name,
            quantity: ingredient.quantity,
            unit: ingredient.unit
          }))
        );
        if (ingredientsError) throw ingredientsError;
      }

      if (missingStockIngredients.length > 0) {
        const { data: insertedStockItems, error: missingStockError } = await supabase
          .from("stock_items")
          .insert(
            missingStockIngredients.map((ingredient) => ({
              restaurant_id: restaurantId,
              name: ingredient.ingredient_name,
              current_stock: 0,
              unit: ingredient.unit,
              updated_at: new Date().toISOString()
            }))
          )
          .select("id, name, current_stock, unit, updated_at");
        if (missingStockError) throw missingStockError;
        if (Array.isArray(insertedStockItems) && insertedStockItems.length > 0) {
          setStockItems((prev) =>
            [...prev, ...insertedStockItems].sort((a, b) =>
              String(a.name || "").localeCompare(String(b.name || ""), "es", { sensitivity: "base" })
            )
          );
          setStockDraftById((prev) => ({
            ...prev,
            ...Object.fromEntries(insertedStockItems.map((item) => [item.id, formatQuantity(item.current_stock)]))
          }));
          setStockUnitDraftById((prev) => ({
            ...prev,
            ...Object.fromEntries(insertedStockItems.map((item) => [item.id, normalizeStockUnit(item.unit)]))
          }));
          setStockNameDraftById((prev) => ({
            ...prev,
            ...Object.fromEntries(
              insertedStockItems.map((row) => [row.id, normalizeUppercaseText(row.name || "")])
            )
          }));
        }
      }

      await refreshRecipes();
      setRecipeFlash(
        `${editingRecipeId ? "Receta actualizada" : "Receta agregada"}: ${name}.` +
          (missingStockIngredients.length
            ? ` Se crearon ${missingStockIngredients.length} ingrediente(s) faltante(s) en stock con valor 0.`
            : "")
      );
      resetRecipeForm();
    } catch (error) {
      setRecipeError(`No se pudo guardar la receta: ${error.message}`);
    } finally {
      setSavingRecipe(false);
    }
  }

  async function deleteRecipe(recipe) {
    if (!window.confirm(`¿Eliminar la receta ${recipe.name}?`)) return;
    setRecipeError("");
    setRecipeFlash("");
    setDeletingRecipeId(recipe.id);
    const { error } = await supabase.from("stock_recipes").delete().eq("id", recipe.id);
    setDeletingRecipeId(null);
    if (error) {
      setRecipeError(`No se pudo eliminar la receta ${recipe.name}: ${error.message}`);
      return;
    }
    setRecipes((prev) => prev.filter((row) => row.id !== recipe.id));
    setRecipeUseCountById((prev) => {
      const next = { ...prev };
      delete next[recipe.id];
      return next;
    });
    if (editingRecipeId === recipe.id) resetRecipeForm();
    setRecipeFlash(`Receta ${recipe.name} eliminada.`);
  }

  function updateRecipeUseCount(recipeId, nextCount) {
    setRecipeUseCountById((prev) => ({
      ...prev,
      [recipeId]: Math.max(1, parseQuantityValue(nextCount, 1))
    }));
  }

  async function useRecipe(recipe) {
    const useCount = Math.max(1, parseQuantityValue(recipeUseCountById[recipe.id], 1));
    const pendingUpdates = [];
    const missingStockMessages = [];
    const incompatibleUnitMessages = [];
    const insufficientStockMessages = [];

    for (const ingredient of recipe.ingredients) {
      const stockItem = stockByName.get(normalizeStockNameForStorage(ingredient.ingredient_name));
      if (!stockItem) {
        missingStockMessages.push(
          `${ingredient.ingredient_name}: falta ${formatQuantity(parseQuantityValueByUnit(ingredient.quantity, ingredient.unit, 1) * useCount)} ${normalizeStockUnit(ingredient.unit)} en stock.`
        );
        continue;
      }

      const required = parseQuantityValueByUnit(ingredient.quantity, ingredient.unit, 1) * useCount;
      const converted = convertQuantityBetweenUnits(required, ingredient.unit, stockItem.unit);
      if (converted == null) {
        incompatibleUnitMessages.push(
          `${ingredient.ingredient_name}: la receta usa ${normalizeStockUnit(ingredient.unit)} y el stock está en ${normalizeStockUnit(stockItem.unit)}.`
        );
        continue;
      }

      const currentStock = parseQuantityValueByUnit(stockItem.current_stock, stockItem.unit, 0);
      const remaining = Math.round((currentStock - converted) * 1000) / 1000;
      if (remaining < -EPSILON) {
        const missingAmount = Math.max(0, converted - currentStock);
        insufficientStockMessages.push(
          `${ingredient.ingredient_name}: faltan ${formatQuantity(missingAmount)} ${normalizeStockUnit(stockItem.unit)}. Necesitás ${formatQuantity(converted)} y tenés ${formatQuantity(currentStock)}.`
        );
        continue;
      }

      pendingUpdates.push({
        item: stockItem,
        nextStock: Math.max(0, remaining)
      });
    }

    if (missingStockMessages.length || incompatibleUnitMessages.length || insufficientStockMessages.length) {
      const details = [
        ...missingStockMessages,
        ...incompatibleUnitMessages,
        ...insufficientStockMessages
      ];
      setStockFlash("");
      setStockError(
        `No se pudo utilizar la receta ${recipe.name}${useCount > 1 ? ` x${formatQuantity(useCount)}` : ""}:\n- ${details.join("\n- ")}`
      );
      return;
    }

    setStockError("");
    setStockFlash("");
    setUsingRecipeId(recipe.id);

    try {
      const results = await Promise.all(
        pendingUpdates.map(({ item, nextStock }) =>
          supabase
            .from("stock_items")
            .update({
              current_stock: nextStock,
              updated_at: new Date().toISOString()
            })
            .eq("id", item.id)
        )
      );
      const failedUpdate = results.find((result) => result?.error);
      if (failedUpdate?.error) throw failedUpdate.error;

      setStockItems((prev) =>
        prev.map((item) => {
          const updated = pendingUpdates.find((entry) => entry.item.id === item.id);
          return updated ? { ...item, current_stock: updated.nextStock } : item;
        })
      );
      setStockDraftById((prev) => {
        const next = { ...prev };
        for (const update of pendingUpdates) {
          next[update.item.id] = formatQuantity(update.nextStock);
        }
        return next;
      });
      setStockFlash(`Se descontó la receta ${recipe.name} x${formatQuantity(useCount)} del stock.`);
    } catch (error) {
      setStockError(`No se pudo utilizar la receta ${recipe.name}: ${error.message}`);
    } finally {
      setUsingRecipeId(null);
    }
  }

  async function analyzeRecipeWithAi() {
    const text = String(recipeForm.aiText || "").trim();
    if (!text) {
      setRecipeError("Pegá un texto para que la IA intente separar la receta.");
      return;
    }

    setRecipeError("");
    setRecipeFlash("");
    setAnalyzingRecipeText(true);

    try {
      const candidates = buildStockAiCandidates();
      let response = null;
      let lastError = null;
      for (const candidate of candidates) {
        try {
          const res = await fetchWithTimeout(candidate, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ restaurantId, text })
          });
          if ([404, 405].includes(res.status)) continue;
          response = res;
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!response) {
        throw new Error(lastError?.message || "No se pudo contactar el analizador de recetas.");
      }

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || `Error HTTP ${response.status}`);
      }

      const recipe = data?.recipe || {};
      const normalizedIngredients = Array.isArray(recipe.ingredients)
        ? recipe.ingredients
            .map((ingredient) => ({
              ingredient_name: normalizeStockNameForStorage(ingredient.ingredient_name),
              quantity: parseQuantityValueByUnit(ingredient.quantity, ingredient.unit, 1),
              unit: normalizeStockUnit(ingredient.unit)
            }))
            .filter((ingredient) => ingredient.ingredient_name)
        : [];
      const normalizedName =
        normalizeTextWithoutAccents(String(recipe.name || "").trim()) ||
        normalizeTextWithoutAccents(fallbackRecipeNameFromText(text));
      const normalizedPreparation = String(recipe.preparation || "").trim();

      if (!normalizedName && !normalizedPreparation && normalizedIngredients.length === 0) {
        throw new Error("La IA respondió sin datos útiles. Probá con un texto más estructurado.");
      }

      updateRecipeForm({
        name: normalizedName,
        preparation: normalizedPreparation,
        ingredients: normalizedIngredients,
        ingredientInput: "",
        ingredientQuantity: "",
        ingredientUnit: "UNIDAD"
      });
      const completedPieces = [
        normalizedName ? "nombre" : null,
        normalizedPreparation ? "preparacion" : null,
        normalizedIngredients.length ? "ingredientes" : null
      ].filter(Boolean);
      setRecipeFlash(
        completedPieces.length
          ? `La IA completó ${completedPieces.join(", ")}. Revisá y guardá la receta.`
          : "La IA analizó el texto. Revisá y guardá la receta."
      );
    } catch (error) {
      setRecipeError(`No se pudo analizar el texto con IA: ${error.message}`);
    } finally {
      setAnalyzingRecipeText(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
        <h2 className="text-sm font-semibold text-slate-200">Gestor de stock</h2>
        <p className="text-xs text-slate-400">
          Administrá ingredientes del inventario y recetas. El stock y los ingredientes se guardan en mayúsculas para
          evitar duplicados por formato.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setActiveSection("stock")}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
            activeSection === "stock"
              ? "bg-emerald-500 text-slate-950"
              : "border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
          }`}
        >
          Stock
        </button>
        <button
          type="button"
          onClick={() => setActiveSection("recipes")}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
            activeSection === "recipes"
              ? "bg-emerald-500 text-slate-950"
              : "border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
          }`}
        >
          Recetario
        </button>
      </div>

      {activeSection === "stock" ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
            <h3 className="text-sm font-semibold text-slate-200">Agregar ingrediente al stock</h3>
            <div className="mt-3 grid gap-3 md:grid-cols-[minmax(220px,0.8fr)_minmax(270px,0.8fr)_auto]">
              <input
                value={newStockName}
                onChange={(event) => setNewStockName(normalizeUppercaseText(event.target.value))}
                placeholder="INGREDIENTE"
                className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
              />
              <div className="grid gap-3 sm:grid-cols-[110px_160px]">
                <input
                  type="text"
                  inputMode={normalizeStockUnit(newStockUnit) === "UNIDAD" ? "numeric" : "decimal"}
                  value={newStockValue}
                  onChange={(event) => setNewStockValue(normalizeNumericInputByUnit(event.target.value, newStockUnit))}
                  placeholder="STOCK"
                  className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                />
                <select
                  value={newStockUnit}
                  onChange={(event) => {
                    const nextUnit = normalizeStockUnit(event.target.value);
                    setNewStockUnit(nextUnit);
                    setNewStockValue((prev) => normalizeNumericInputByUnit(prev, nextUnit));
                  }}
                  className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                >
                  {STOCK_UNIT_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => {
                  void addStockItem();
                }}
                disabled={addingStock || !restaurantId}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                {addingStock ? "Guardando..." : "Agregar"}
              </button>
            </div>
            {stockError ? (
              <p className="mt-3 whitespace-pre-wrap rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {stockError}
              </p>
            ) : null}
            {stockFlash ? (
              <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-100/95">
                {stockFlash}
              </p>
            ) : null}
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-200">Stock actual</h3>
                  <p className="mt-1 text-xs text-slate-500">
                    El nombre se edita con el botón Editar; cantidad y unidad se guardan con Guardar.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {STOCK_UNIT_OPTIONS.map((unit) => {
                    const selected = stockUnitVisibility[unit] !== false;
                    return (
                      <button
                        key={unit}
                        type="button"
                        onClick={() =>
                          setStockUnitVisibility((prev) => ({
                            ...prev,
                            [unit]: prev[unit] === false
                          }))
                        }
                        className={`rounded-lg px-3 py-2 text-xs font-medium transition ${
                          selected
                            ? "bg-emerald-500 text-slate-950 hover:bg-emerald-400"
                            : "border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
                        }`}
                      >
                        {unit}
                      </button>
                    );
                  })}
                </div>
              </div>

              {loadingStock ? (
                <p className="mt-4 text-sm text-slate-500">Cargando stock...</p>
              ) : stockItems.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">Todavía no hay ingredientes cargados en stock.</p>
              ) : visibleStockItems.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">
                  No hay ingredientes visibles con las métricas seleccionadas.
                </p>
              ) : (
                <div className="mt-4 space-y-3">
                  {visibleStockItems.map((item) => {
                    const currentValue = parseQuantityValueByUnit(item.current_stock, item.unit, 0);
                    const draftUnit = stockUnitDraftById[item.id] ?? normalizeStockUnit(item.unit);
                    const draftValue = stockDraftById[item.id] ?? formatQuantity(parseQuantityValueByUnit(currentValue, draftUnit, 0));
                    const parsedDraftValue = parseQuantityValueByUnit(draftValue, draftUnit, 0);
                    const rowBusy = savingStockId === item.id;
                    const nameDraftValue = stockNameDraftById[item.id] ?? normalizeUppercaseText(item.name || "");
                    const editingName = editingStockNameId === item.id;
                    const nameDirty =
                      normalizeStockNameForStorage(nameDraftValue) !== normalizeStockNameForStorage(item.name);
                    const qtyDirty =
                      Math.abs(parsedDraftValue - currentValue) >= EPSILON ||
                      normalizeStockUnit(draftUnit) !== normalizeStockUnit(item.unit);
                    return (
                      <div
                        key={item.id}
                        className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3 lg:flex-row lg:items-center lg:justify-between"
                      >
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="block min-w-0">
                            <span className="text-[11px] text-slate-500">Nombre</span>
                            {editingName ? (
                              <input
                                type="text"
                                value={nameDraftValue}
                                onChange={(event) =>
                                  setStockNameDraftById((prev) => ({
                                    ...prev,
                                    [item.id]: normalizeUppercaseText(event.target.value)
                                  }))
                                }
                                disabled={rowBusy}
                                autoFocus
                                className="mt-0.5 h-10 w-full max-w-md rounded-lg border border-sky-500/50 bg-slate-950 px-3 text-sm font-medium text-slate-100 outline-none ring-1 ring-sky-500/30 disabled:opacity-50"
                                autoComplete="off"
                              />
                            ) : (
                              <div
                                className="mt-0.5 flex h-10 w-full max-w-md cursor-default items-center rounded-lg border border-slate-700 bg-slate-950/80 px-3 text-sm font-medium text-slate-100 select-none"
                                tabIndex={-1}
                                aria-readonly="true"
                              >
                                {nameDraftValue || "—"}
                              </div>
                            )}
                          </div>
                          <p className="text-xs text-slate-500">
                            Stock actual: {formatStockDisplay(currentValue, item.unit)}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={rowBusy || parsedDraftValue <= 0}
                            onClick={() => {
                              adjustStockDraft(item, -1);
                            }}
                            className="h-10 w-10 rounded-lg border border-slate-600 text-lg leading-none text-slate-300 hover:bg-slate-800 disabled:opacity-30"
                          >
                            −
                          </button>
                          <span className="min-w-[3.5rem] text-center text-lg font-semibold tabular-nums text-slate-100">
                            {formatQuantity(parsedDraftValue)}
                          </span>
                          <button
                            type="button"
                            disabled={rowBusy}
                            onClick={() => {
                              adjustStockDraft(item, 1);
                            }}
                            className="h-10 w-10 rounded-lg bg-emerald-600 text-lg font-semibold leading-none text-white hover:bg-emerald-500 disabled:opacity-50"
                          >
                            +
                          </button>
                          <input
                            type="text"
                            inputMode={draftUnit === "UNIDAD" ? "numeric" : "decimal"}
                            value={draftValue}
                            onChange={(event) =>
                              setStockDraftById((prev) => ({
                                ...prev,
                                [item.id]: normalizeNumericInputByUnit(event.target.value, draftUnit)
                              }))
                            }
                            className="h-10 w-24 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                          />
                          <select
                            value={draftUnit}
                            onChange={(event) => {
                              const nextUnit = normalizeStockUnit(event.target.value);
                              setStockUnitDraftById((prev) => ({
                                ...prev,
                                [item.id]: nextUnit
                              }));
                              setStockDraftById((prev) => ({
                                ...prev,
                                [item.id]: normalizeNumericInputByUnit(prev[item.id] ?? draftValue, nextUnit)
                              }));
                            }}
                            className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                          >
                            {STOCK_UNIT_OPTIONS.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={rowBusy || (!nameDirty && !qtyDirty)}
                            onClick={() => {
                              void saveStockItemRow(item);
                            }}
                            className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                          >
                            Guardar
                          </button>
                          {editingName ? (
                            <>
                              <button
                                type="button"
                                disabled={rowBusy}
                                onClick={() => setEditingStockNameId(null)}
                                className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                              >
                                Listo
                              </button>
                              <button
                                type="button"
                                disabled={rowBusy}
                                onClick={() => {
                                  setStockNameDraftById((prev) => ({
                                    ...prev,
                                    [item.id]: normalizeUppercaseText(item.name || "")
                                  }));
                                  setEditingStockNameId(null);
                                }}
                                className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-medium text-slate-400 hover:bg-slate-800 disabled:opacity-50"
                              >
                                Cancelar
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              disabled={rowBusy}
                              onClick={() => {
                                setStockNameDraftById((prev) => ({
                                  ...prev,
                                  [item.id]: normalizeUppercaseText(item.name || "")
                                }));
                                setEditingStockNameId(item.id);
                              }}
                              className="rounded-lg border border-sky-500/45 bg-sky-500/15 px-3 py-2 text-xs font-medium text-sky-200 hover:bg-sky-500/25 disabled:opacity-50"
                            >
                              Editar
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={rowBusy}
                            onClick={() => {
                              void deleteStockItem(item);
                            }}
                            className="rounded-lg border border-rose-500/40 px-3 py-2 text-xs font-medium text-rose-200 hover:bg-rose-500/10 disabled:opacity-50"
                          >
                            Eliminar
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
              <h3 className="text-sm font-semibold text-slate-200">Usar recetas</h3>
              <p className="mt-1 text-xs text-slate-500">
                Elegí cuántas veces querés usar una receta y descontá sus ingredientes del stock.
              </p>
              <input
                type="text"
                value={recipeSearchQuery}
                onChange={(event) => setRecipeSearchQuery(normalizeTextWithoutAccents(event.target.value))}
                placeholder="Buscar receta por nombre, preparacion o ingrediente"
                className="mt-3 h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
              />

              {loadingRecipes ? (
                <p className="mt-4 text-sm text-slate-500">Cargando recetas...</p>
              ) : recipes.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">Todavía no hay recetas cargadas para usar.</p>
              ) : recipesForUse.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">No hay recetas que coincidan con la búsqueda.</p>
              ) : (
                <div className="mt-4 space-y-3">
                  {recipesForUse.map((recipe) => {
                    const useCount = Math.max(1, parseQuantityValue(recipeUseCountById[recipe.id], 1));
                    const busy = usingRecipeId === recipe.id;
                    return (
                      <div key={recipe.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <h4 className="font-semibold text-slate-100">{recipe.name}</h4>
                            <p className="mt-1 text-xs text-slate-500">
                              {recipe.ingredients.length
                                ? recipe.ingredients
                                    .map(
                                      (ingredient) =>
                                        `${ingredient.ingredient_name} ${formatQuantity(ingredient.quantity)} ${normalizeStockUnit(ingredient.unit)}`
                                    )
                                    .join(" · ")
                                : "Sin ingredientes cargados."}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => startEditingRecipe(recipe)}
                            className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800"
                          >
                            Editar
                          </button>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={busy || useCount <= 1}
                            onClick={() => updateRecipeUseCount(recipe.id, useCount - 1)}
                            className="h-10 w-10 rounded-lg border border-slate-600 text-lg leading-none text-slate-300 hover:bg-slate-800 disabled:opacity-30"
                          >
                            −
                          </button>
                          <span className="min-w-[3rem] text-center text-lg font-semibold tabular-nums text-slate-100">
                            {formatQuantity(useCount)}
                          </span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => updateRecipeUseCount(recipe.id, useCount + 1)}
                            className="h-10 w-10 rounded-lg bg-emerald-600 text-lg font-semibold leading-none text-white hover:bg-emerald-500 disabled:opacity-50"
                          >
                            +
                          </button>
                          <button
                            type="button"
                            disabled={busy || recipe.ingredients.length === 0}
                            onClick={() => {
                              void useRecipe(recipe);
                            }}
                            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                          >
                            {busy ? "Descontando..." : "Utilizar receta"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-200">Recetario cargado</h3>
                <p className="mt-1 text-xs text-slate-500">Podés guardar recetas, preparación e ingredientes.</p>
              </div>
              {recipeFlash ? (
                <span className="rounded-full border border-emerald-500/30 bg-emerald-950/30 px-3 py-1 text-xs text-emerald-100/95">
                  {recipeFlash}
                </span>
              ) : null}
            </div>

            {recipeError ? (
              <p className="mt-3 rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {recipeError}
              </p>
            ) : null}

            {loadingRecipes ? (
              <p className="mt-4 text-sm text-slate-500">Cargando recetario...</p>
            ) : recipes.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">Todavía no hay recetas cargadas.</p>
            ) : (
              <div className="mt-4 space-y-3">
                {recipes.map((recipe) => (
                  <div key={recipe.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <h4 className="font-semibold text-slate-100">{recipe.name}</h4>
                        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">
                          {recipe.preparation || "Sin preparación cargada."}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => startEditingRecipe(recipe)}
                          className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800"
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          disabled={deletingRecipeId === recipe.id}
                          onClick={() => {
                            void deleteRecipe(recipe);
                          }}
                          className="rounded-lg border border-rose-500/40 px-3 py-2 text-xs font-medium text-rose-200 hover:bg-rose-500/10 disabled:opacity-50"
                        >
                          {deletingRecipeId === recipe.id ? "Eliminando..." : "Eliminar"}
                        </button>
                      </div>
                    </div>

                    <div className="mt-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Ingredientes</p>
                      {recipe.ingredients.length ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {recipe.ingredients.map((ingredient) => (
                            <span
                              key={ingredient.id}
                              className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-200"
                            >
                              {ingredient.ingredient_name} · {formatQuantity(ingredient.quantity)} {normalizeStockUnit(ingredient.unit)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-slate-500">Sin ingredientes cargados.</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-200">
                {editingRecipeId ? "Editar receta" : "Nueva receta"}
              </h3>
              <button
                type="button"
                onClick={() => setShowAiAssistant((prev) => !prev)}
                className="rounded-lg border border-violet-500/35 bg-violet-950/30 px-3 py-2 text-xs font-medium text-violet-100 hover:bg-violet-900/40"
              >
                Usar IA
              </button>
            </div>

            <div className="mt-3 space-y-3">
              {showAiAssistant ? (
                <div className="rounded-xl border border-violet-500/25 bg-violet-950/20 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-violet-200/90">Asistente IA</p>
                  <p className="mt-1 text-xs text-violet-100/80">
                    Pegá una receta completa y la IA intentará separar nombre, preparación e ingredientes.
                  </p>
                  <textarea
                    value={recipeForm.aiText}
                    onChange={(event) => updateRecipeForm({ aiText: event.target.value })}
                    rows={6}
                    placeholder="Pegá acá la receta o preparación completa..."
                    className="mt-3 w-full rounded-lg border border-violet-500/20 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void analyzeRecipeWithAi();
                      }}
                      disabled={analyzingRecipeText || !restaurantId}
                      className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-violet-400 disabled:opacity-50"
                    >
                      {analyzingRecipeText ? "Analizando..." : "Analizar texto"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowAiAssistant(false)}
                      className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
                    >
                      Cerrar
                    </button>
                  </div>
                </div>
              ) : null}

              <input
                value={recipeForm.name}
                onChange={(event) => updateRecipeForm({ name: normalizeTextWithoutAccents(event.target.value) })}
                placeholder="Nombre de la receta"
                className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
              />

              <textarea
                value={recipeForm.preparation}
                onChange={(event) => updateRecipeForm({ preparation: event.target.value })}
                placeholder="Cómo prepararla"
                rows={6}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              />

              <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Ingredientes</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_100px_140px_auto]">
                  <input
                    value={recipeForm.ingredientInput}
                    onChange={(event) =>
                      updateRecipeForm({ ingredientInput: normalizeUppercaseText(event.target.value) })
                    }
                    placeholder="INGREDIENTE"
                    className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                  />
                  <input
                    type="text"
                    inputMode={normalizeStockUnit(recipeForm.ingredientUnit) === "UNIDAD" ? "numeric" : "decimal"}
                    value={recipeForm.ingredientQuantity}
                    onChange={(event) =>
                      updateRecipeForm({
                        ingredientQuantity: normalizeNumericInputByUnit(event.target.value, recipeForm.ingredientUnit)
                      })
                    }
                    placeholder="CANT."
                    className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                  />
                  <select
                    value={recipeForm.ingredientUnit}
                    onChange={(event) => {
                      const nextUnit = normalizeStockUnit(event.target.value);
                      updateRecipeForm({
                        ingredientUnit: nextUnit,
                        ingredientQuantity: normalizeNumericInputByUnit(recipeForm.ingredientQuantity, nextUnit)
                      });
                    }}
                    className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                  >
                    {STOCK_UNIT_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={addIngredientToRecipeForm}
                    className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
                  >
                    Agregar
                  </button>
                </div>

                {recipeForm.ingredients.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {recipeForm.ingredients.map((ingredient) => (
                      <button
                        key={`${ingredient.ingredient_name}-${ingredient.unit}-${ingredient.quantity}`}
                        type="button"
                        onClick={() =>
                          removeIngredientFromRecipeForm(
                            ingredient.ingredient_name,
                            ingredient.unit,
                            ingredient.quantity
                          )
                        }
                        className="rounded-full border border-emerald-500/30 bg-emerald-950/30 px-2.5 py-1 text-xs text-emerald-100/95 hover:bg-emerald-900/40"
                      >
                        {ingredient.ingredient_name} · {formatQuantity(ingredient.quantity)} {normalizeStockUnit(ingredient.unit)} ×
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-slate-500">Todavía no agregaste ingredientes.</p>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void saveRecipe();
                  }}
                  disabled={savingRecipe || !restaurantId}
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                >
                  {savingRecipe ? "Guardando..." : editingRecipeId ? "Guardar cambios" : "Crear receta"}
                </button>
                {editingRecipeId ? (
                  <button
                    type="button"
                    onClick={resetRecipeForm}
                    disabled={savingRecipe}
                    className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                  >
                    Cancelar edición
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
