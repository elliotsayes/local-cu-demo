import { executeMessage, handleRegisterProcess } from './lib/eagerWorker'
import { useMutation } from '@tanstack/react-query'
import { connect } from '@permaweb/aoconnect'
import { Benchmark } from './lib/benchmark'
import { queryCmd } from './lib/cmd'
import { createMessage } from './lib/msg'

const testProcessId = "0RE7SPZ7wDuk__nnLqhSswciuCgJMfLFC5cw0TqRiNI"

export function Demo() {
  const remoteEval = useMutation({
    mutationKey: ['remoteEval', testProcessId],
    mutationFn: async (cmd: string) => {
      const client = connect()
      
      const bench = Benchmark.measure()
      const result = await client.dryrun({
        process: testProcessId,
        data: cmd,
        tags: [
          { name: 'Action', value: 'Eval' }
        ],
      })
      const elapsed = bench.elapsed()
      return {
        output: result.Output,
        elapsed,
      }
    },
  })

  const registration = useMutation({
    mutationKey: ['register', testProcessId],
    mutationFn: async () => {
      await handleRegisterProcess(testProcessId)
    },
  })

  const localEval = useMutation({
    mutationKey: ['localEval', testProcessId],
    mutationFn: async () => {
      const bench = Benchmark.measure()
      const result = await executeMessage(testProcessId, createMessage(queryCmd))
      const elapsed = bench.elapsed()
      return {
        output: result?.Output,
        elapsed,
      }
    },
  })

  return (
    <>
      <h1>WebCU Demo</h1>
      <div className="card">
        <button 
          onClick={() => remoteEval.mutateAsync(queryCmd)}
          disabled={remoteEval.isPending}
        >
          Run remote eval
        </button>
        <p>
          Status: {remoteEval.status}
        </p>
        {
          remoteEval.isSuccess && (
            <div>
              <p>
                Output: {remoteEval.data.output}
              </p>
              <p>
                Elapsed: {remoteEval.data.elapsed}ms
              </p>
            </div>
          )
        }
      </div>
      <div className="card">
        <button 
          onClick={() => registration.mutateAsync()}
          disabled={registration.isPending}
        >
          Register process for listening
        </button>
        <p>
          Status: {registration.status}
        </p>
        <p>
          {
            registration.isSuccess
              ? "Registered!"
              : "Waiting for registration"
          }
        </p>
      </div>
      <div className="card">
        <button
          onClick={() => localEval.mutateAsync()}
          disabled={localEval.isPending}
        >
          Run local eval
        </button>
        <p>
          Status: {localEval.status}
        </p>
        {
          localEval.isSuccess && (
            <div>
              <p>
                Output: {localEval.data.output}
              </p>
              <p>
                Elapsed: {localEval.data.elapsed}ms
              </p>
            </div>
          )
        }
      </div>
    </>
  )
}
