export type ResultFormatter<T> = (payload: T) => string;

export async function printResult<T>(
  payload: T,
  options: { json?: boolean; formatter: ResultFormatter<T> }
): Promise<void> {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(options.formatter(payload));
}
