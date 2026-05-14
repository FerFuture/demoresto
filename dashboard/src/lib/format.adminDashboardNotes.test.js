import { describe, expect, it } from "vitest";
import {
  adminDashboardNotesBlock,
  adminShowClienteNroRow,
  waiterNameFromMozoNotes
} from "./format.js";

describe("waiterNameFromMozoNotes", () => {
  it("extrae el nombre al final de las notas del mozo", () => {
    expect(waiterNameFromMozoNotes("Mozo · Mesa: 4 · Mozo: Ana")).toBe("Ana");
  });
  it("devuelve cadena vacía si no hay sufijo Mozo:", () => {
    expect(waiterNameFromMozoNotes("Mozo · Mesa: 2")).toBe("");
  });
});

describe("adminShowClienteNroRow", () => {
  it("oculta para pedido mozo (notas típicas)", () => {
    expect(
      adminShowClienteNroRow({
        notes: "Mozo · Mesa: 3 · Mozo: Ana",
        customer_number: "5492616696183",
        fulfillment_type: "mesa"
      })
    ).toBe(false);
  });
  it("oculta para mesa carta/QR sin customer_number", () => {
    expect(
      adminShowClienteNroRow({
        notes: "Mesa: 5",
        customer_number: "",
        fulfillment_type: "mesa"
      })
    ).toBe(false);
  });
  it("muestra para cliente en mesa por WhatsApp", () => {
    expect(
      adminShowClienteNroRow({
        notes: "modalidad: mesa",
        customer_number: "5491112345678",
        fulfillment_type: "mesa"
      })
    ).toBe(true);
  });
});

describe("adminDashboardNotesBlock · pedido mozo", () => {
  it("concatena Items con Mozo cuando hay nombre en notas", () => {
    const order = {
      notes: "Mozo · Mesa: 3 · Mozo: Luis",
      payment_method: "efectivo_mesa",
      fulfillment_type: "mesa",
      items: [{ name: "Empanada" }, { name: "Empanada" }]
    };
    const out = adminDashboardNotesBlock(order);
    expect(out).toContain("Items:");
    expect(out).toContain("Empanada");
    expect(out).toContain("// Mozo: Luis");
  });
});
