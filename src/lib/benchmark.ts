export const Benchmark = {
  measure: () => {
    const start = Date.now()
    return {
      elapsed: () => {
        return Date.now() - start
      }
    }
  }
}