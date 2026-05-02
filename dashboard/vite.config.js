import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";

function readRootEnv() {
  const envPath = "/app/.env";
  if (!fs.existsSync(envPath)) return {};

  const raw = fs.readFileSync(envPath, "utf8");
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

const rootEnv = readRootEnv();

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173
  },
  define: {
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(rootEnv.SUPABASE_URL || ""),
    "import.meta.env.VITE_SUPABASE_KEY": JSON.stringify(rootEnv.SUPABASE_KEY || ""),
    "import.meta.env.VITE_BOT_WHATSAPP_NUMBER": JSON.stringify(
      rootEnv.DASHBOARD_BOT_WHATSAPP_NUMBER || rootEnv.WWEBJS_BOT_NUMBER || ""
    ),
    "import.meta.env.VITE_ADMIN_PASSWORD": JSON.stringify(rootEnv.VITE_ADMIN_PASSWORD || ""),
    "import.meta.env.VITE_DELIVERY_PASSWORD": JSON.stringify(rootEnv.VITE_DELIVERY_PASSWORD || "")
  }
});
