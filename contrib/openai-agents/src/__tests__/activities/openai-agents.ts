export async function getWeather(input: { location: string }): Promise<string> {
  const weatherData: Record<string, string> = {
    tokyo: 'Sunny, 22°C',
    london: 'Cloudy, 15°C',
  };
  const weather = weatherData[input.location.toLowerCase()] ?? 'Unknown';
  return JSON.stringify({ location: input.location, weather });
}

export async function calculateSum(input: { a: number; b: number }): Promise<string> {
  return JSON.stringify({ result: input.a + input.b });
}
