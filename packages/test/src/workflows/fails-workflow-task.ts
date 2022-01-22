export async function failsWorkflowTask(): Promise<void> {
  throw new Error('Intentionally failing workflow task');
}
