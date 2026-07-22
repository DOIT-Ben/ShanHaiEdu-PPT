export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('CONCURRENCY_INVALID')
  if (values.length === 0) return []

  const results = new Array<R>(values.length)
  let nextIndex = 0
  let stopped = false
  let failure: unknown = null
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!stopped) {
      const index = nextIndex
      nextIndex += 1
      if (index >= values.length) return
      try {
        results[index] = await operation(values[index]!, index)
      } catch (error) {
        failure ??= error
        stopped = true
      }
    }
  })
  await Promise.all(workers)
  if (failure !== null) throw failure
  return results
}
