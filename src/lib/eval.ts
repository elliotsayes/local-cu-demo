import AoLoader from '@permaweb/ao-loader';

export async function evaluateMemory(
  moduleData: ArrayBuffer,
  initialMemory: ArrayBuffer | null,
  messages: Array<AoLoader.Message>,
  env: AoLoader.Environment
) {
  // console.debug(`Loading module with env ${JSON.stringify(env)}`)
  const handle = await AoLoader(moduleData, { format: 'wasm32-unknown-emscripten2' });

  let workingMemory = initialMemory;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    console.log(`Evaluating message`, message)

    let result: AoLoader.HandleResponse | undefined = undefined;
    try {
      result = await handle(workingMemory, message, env);
      console.log(`Successfully evaluated message ${i}`, result)
    } catch (e) {
      console.error(e)
    }
    if (result) {
      workingMemory = result.Memory;
    }
  }
  return workingMemory;
}
