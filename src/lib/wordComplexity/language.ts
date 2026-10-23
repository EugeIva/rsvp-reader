import type { Language } from "./types";

export function detectLanguage(text: string): Language {
    const cyrillic = (text.match(/[\u0400-\u04FF]/g) || []).length;
    const latin = (text.match(/[a-zA-Z]/g) || []).length;
    return cyrillic > latin ? "ru" : "en";
}