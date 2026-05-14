import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  return raw.split("\n").reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return acc;
    const separator = trimmed.indexOf("=");
    if (separator < 0) return acc;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    acc[key] = value;
    return acc;
  }, {});
}

function pick(...candidates) {
  for (const c of candidates) {
    if (c !== undefined && c !== null && String(c).trim() !== "") return String(c);
  }
  return "";
}

/** Solo inyecta en el bundle si hay valor; si no, Vite puede usar VITE_* del entorno sin pisarlas con "". */
function defineIfPresent(defineKey, value) {
  const v = pick(value);
  return v ? { [defineKey]: JSON.stringify(v) } : {};
}

/**
 * Carpeta donde está el `.env` real. En Docker el proyecto vive en `/app` y el compose monta el `.env`
 * del repo en `/app/.env`; el padre de `/app` es `/`, así que no sirve usar solo `../`.
 */
function resolveEnvDir() {
  const repoParent = path.join(__dirname, "..");
  const candidates = [repoParent, __dirname, "/app"];
  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(path.join(dir, ".env"))) return dir;
    } catch {
      /* ignore */
    }
  }
  return repoParent;
}

export default defineConfig(({ mode }) => {
  const repoRoot = path.join(__dirname, "..");
  const envDirResolved = resolveEnvDir();
  const fromFiles = {
    ...loadEnv(mode, repoRoot, ""),
    ...loadEnv(mode, __dirname, ""),
    ...readDotEnvFile("/app/.env"),
    ...loadEnv(mode, envDirResolved, "")
  };

  const supabaseUrl = pick(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_URL,
    fromFiles.VITE_SUPABASE_URL,
    fromFiles.SUPABASE_URL
  );
  const supabaseKey = pick(
    process.env.VITE_SUPABASE_KEY,
    process.env.SUPABASE_KEY,
    fromFiles.VITE_SUPABASE_KEY,
    fromFiles.SUPABASE_KEY
  );
  const botNumber = pick(
    process.env.VITE_BOT_WHATSAPP_NUMBER,
    process.env.BOT_WHATSAPP_NUMBER,
    fromFiles.VITE_BOT_WHATSAPP_NUMBER,
    fromFiles.BOT_WHATSAPP_NUMBER,
    fromFiles.DASHBOARD_BOT_WHATSAPP_NUMBER,
    fromFiles.WWEBJS_BOT_NUMBER
  );
  const adminPw = pick(process.env.VITE_ADMIN_PASSWORD, fromFiles.VITE_ADMIN_PASSWORD);
  const deliveryPw = pick(process.env.VITE_DELIVERY_PASSWORD, fromFiles.VITE_DELIVERY_PASSWORD);
  const maestroPw = pick(process.env.VITE_MAESTRO_PASSWORD, fromFiles.VITE_MAESTRO_PASSWORD);
  const mesaQrSecret = pick(process.env.VITE_MESA_QR_SECRET, fromFiles.VITE_MESA_QR_SECRET);
  const publicDashboardUrl = pick(
    process.env.VITE_PUBLIC_DASHBOARD_URL,
    fromFiles.VITE_PUBLIC_DASHBOARD_URL
  );

  const isVercelBuild = Boolean(process.env.VERCEL);
  if (isVercelBuild && mode === "production" && (!supabaseUrl || !supabaseKey)) {
    throw new Error(
      "Build en Vercel: faltan SUPABASE_URL y SUPABASE_KEY (o VITE_SUPABASE_URL / VITE_SUPABASE_KEY). " +
        "Configurálos en Project → Settings → Environment Variables para Production y redeploy."
    );
  }

  return {
    plugins: [react()],
    envDir: envDirResolved,
    server: {
      host: "0.0.0.0",
      port: 5173
    },
    define: {
      ...defineIfPresent("import.meta.env.VITE_SUPABASE_URL", supabaseUrl),
      ...defineIfPresent("import.meta.env.VITE_SUPABASE_KEY", supabaseKey),
      ...defineIfPresent("import.meta.env.VITE_BOT_WHATSAPP_NUMBER", botNumber),
      ...defineIfPresent("import.meta.env.VITE_ADMIN_PASSWORD", adminPw),
      ...defineIfPresent("import.meta.env.VITE_DELIVERY_PASSWORD", deliveryPw),
      ...defineIfPresent("import.meta.env.VITE_MAESTRO_PASSWORD", maestroPw),
      ...defineIfPresent("import.meta.env.VITE_MESA_QR_SECRET", mesaQrSecret),
      ...defineIfPresent("import.meta.env.VITE_PUBLIC_DASHBOARD_URL", publicDashboardUrl)
    }
  };
});
