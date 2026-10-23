import { invoke } from "@tauri-apps/api/core";
import type { BookMetadata } from "./types";

export async function openEpub(path: string): Promise<BookMetadata> {
    return invoke<BookMetadata>("open_epub", { path });
}

export async function getChapterHtml(index: number): Promise<string> {
    return invoke<string>("get_chapter_html", { index });
}

/** Pixel size [width, height] of each image, or null where it is unknown. */
export async function getImageSizes(paths: string[]): Promise<([number, number] | null)[]> {
    return invoke<([number, number] | null)[]>("get_image_sizes", { paths });
}

export interface ResolvedLink {
    chapter_index: number;
    anchor: string | null;
}

/** Resolve a link clicked in chapter `from` to the chapter it points at. */
export async function resolveChapterLink(href: string, from: number): Promise<ResolvedLink> {
    return invoke<ResolvedLink>("resolve_chapter_link", { href, from });
}

/** A book macOS asked the app to open from Finder, not yet opened (taken once). */
export async function takePendingOpen(): Promise<string | null> {
    return invoke<string | null>("take_pending_open");
}
