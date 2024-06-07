import { executeMessage, handleRegisterProcess } from './lib/eagerWorker'
import { useMutation } from '@tanstack/react-query'
import { connect } from '@permaweb/aoconnect'
import { queryCmd } from './lib/cmd'
import { createMessage } from './lib/msg'

const testProcessId = "T3Dy2pYzx_6h3T9YqCQcwpTKsBlRd9_70lzI9mNA6q4"
const testAddress = "cKqPkIHDxNe69V7_Jj7bIlmIapCN7q3dkTxqfihKt6k"

export function Demo() {
  const remoteEval = useMutation({
    mutationKey: ['remoteEval', testProcessId],
    mutationFn: async (cmd: string) => {
      const client = connect()
      const result = await client.dryrun({
        process: testProcessId,
        data: cmd,
        tags: [
          { name: 'Action', value: 'Query' }
        ],
      })
      return {
        result,
        elapsed: 0,
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
      const result = await executeMessage(
        testProcessId,
        createMessage(testProcessId ,testAddress, queryCmd),
      )
      return {
        result,
        elapsed: 0,
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
                Output: {remoteEval.data.result?.Messages[0]?.Data}
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
          disabled={localEval.isPending || !registration.isSuccess}
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
                Output: {localEval.data.result?.Messages[0]?.Data}
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
