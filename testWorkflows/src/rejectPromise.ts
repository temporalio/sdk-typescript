class CustomError extends Error {
  public readonly name: string = 'CustomError';
}

export async function main() {
  try {
    await new Promise((_, reject) => reject(new CustomError('abc')));
  } catch (err) {
    console.log(err instanceof CustomError);
  }
}
