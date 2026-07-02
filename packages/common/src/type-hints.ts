export type TypeHint = unknown;

export interface PayloadTypeHints {
	inputTypes?: readonly TypeHint[];
	outputType?: TypeHint;
}