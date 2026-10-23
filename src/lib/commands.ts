import { invoke } from "@tauri-apps/api/core";
import type { BookMetadata } from "./types";

export async function openEpub(path: string): Promise<BookMetadata> {
    return invoke<BookMetadata>("open_epub", { path });
}

export async function getChapterHtml(index: number): Promise<string> {
    return invoke<string>("get_chapter_html", { index });
}

export async function getChapterText(index: number): Promise<string> {
    return invoke<string>("get_chapter_text", { index });
}

export async function getChapterResource(path: string): Promise<string> {
    return invoke<string>("get_chapter_resource", { path });
}

export interface ResolvedLink {
    chapter_index: number;
    anchor: string | null;
}

export async function resolveChapterLink(href: string): Promise<ResolvedLink> {
    return invoke<ResolvedLink>("resolve_chapter_link", { href });
}