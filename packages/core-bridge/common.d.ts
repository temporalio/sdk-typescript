export const targets: string[];

export class PrebuildError extends Error {}

export function getPrebuiltTargetName(): string;

export function getPrebuiltPath(): string;
