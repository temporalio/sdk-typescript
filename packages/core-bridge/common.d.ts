export const targets: string[];

export const archAlias: Record<string, string>;

export const platformMapping: Record<string, string>;

export class PrebuildError extends Error {}

export function getPrebuiltTargetName(): string;

export function getPrebuiltPath(): string;

export function requirePrebuilt(): Record<string, unknown>;
