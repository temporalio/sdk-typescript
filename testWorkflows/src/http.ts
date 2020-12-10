export async function main() {
  {
    const body = await activities.httpGet('https://google.com');
    console.log(body);
  }
  {
    const body = await activities.httpGet.withOptions({ retries: 3 }).invoke('http://example.com');
    console.log(body);
  }
}
