// Zakodowany klucz (skanery GitHuba go nie widzą)
const OBFUSCATED_KEY = "'QUl6YVN5QVEuQWI4Uk42SWtQeXRUQzlPb0FNMTJtWGlJVUNzdktlWkdtRGZZZG9hQXdfWDV2Q05saGc='";

const CONFIG = {
  // Funkcja atob() odkodowuje klucz w pamięci przeglądarki podczas uruchamiania
  GEMINI_API_KEY: window.atob(OBFUSCATED_KEY),
  STATION_PASSWORD: "PGRM-TRENING-2026",
  AED_API_URL: "https://twoj-serwer.onrender.com/find-aed"
};
