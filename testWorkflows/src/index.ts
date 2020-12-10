export async function main() {
  const body = await activities.httpGet('http://example.com');
  console.log(body);
}
