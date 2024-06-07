/// <reference lib="webworker" />

import { ResponseKeyCache, WrappedResponseKeyCache } from "./cache";
import { evaluateMemory } from "./eval";
import { ProcessDef } from "./model";
import { fetchModuleSourceRequest, fetchProcessDef, loadMessages } from "./result";
import AoLoader, { Message } from "@permaweb/ao-loader";

const logger = console;

const registeredProcesses = new Set<string>();

// Used by the updater to cache module data
const processDefCache = new WrappedResponseKeyCache('process-def');
const moduleDataCache = new ResponseKeyCache('module-data');

// Maintained by the updater & read by the evaluator
const lastCachedProcessMemory = new Map<string, number>(); // Map(processId, lastEvaluatedMessageTs)
const processMemoryCache = new WrappedResponseKeyCache('process-memory');

async function initializeCaches() {
  await Promise.all([
    processDefCache.init(),
    moduleDataCache.init(),
    processMemoryCache.init(),
  ])
}

initializeCaches().then(() => {
  logger.info("Caches ready")
})

export async function handleRegisterProcess(processId: string) {
  if (registeredProcesses.has(processId)) {
    logger.info(`Process ${processId} already registered`);
    return;
  }

  logger.info(`Registering process ${processId}`);
  await updateLocalProcess(processId);
  registeredProcesses.add(processId);
  logger.info(`Registered process ${processId} complete`);

  const interval = async () => {
    try {
      logger.info(`Updating process ${processId}`);
      await updateLocalProcess(processId);
    } catch (e) {
      console.error(`Error when updating process ${processId}`, e);
    } finally { // Cooldown
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      interval(); // unawaited
    }
  };

  // Start the first call
  interval();
}

async function updateLocalProcess(processId: string) {
  const processDef = await processDefCache.cachedOr<ProcessDef>(
    processId,
    () => fetchProcessDef(processId),
    (response) => response.json(),
    (data) => Promise.resolve(new Response(JSON.stringify(data))),
  );
  const moduleResponse = await moduleDataCache.cachedOr(
    processDef.moduleTxId,
    () => fetchModuleSourceRequest(processDef.moduleTxId),
  );
  
  const moduleData = await moduleResponse.arrayBuffer();
  
  let memoryInitial: ArrayBuffer | null | undefined;
  let evalMessages: Array<AoLoader.Message>;

  const lastMemoryTimestamp = lastCachedProcessMemory.get(processId);
  if (lastMemoryTimestamp) {
    logger.debug(`Getting memory from cache for ${processId}:${lastMemoryTimestamp}`);
    // Get memory from cache
    memoryInitial = await processMemoryCache.cached(
      `${processId}-${lastMemoryTimestamp}`,
      (response) => response.arrayBuffer(),
    );
    if (!memoryInitial) {
      logger.warn(`Memory not found in cache for ${processId}:${lastMemoryTimestamp}`);
      // Clear last cached memory & try again
      lastCachedProcessMemory.delete(processId);
      return updateLocalProcess(processId);
    }
    // Get messages since last memory update
    evalMessages = await loadMessages(processDef.moduleTxId, processId, lastMemoryTimestamp);
  } else {
    // Start from empty memory
    memoryInitial = null;
    // Get all messages
    evalMessages = await loadMessages(processDef.moduleTxId, processId, 0);
  }

  if (evalMessages.length === 0) {
    logger.info(`No messages for ${processId}`);
    
    return;
  }
  
  // Run the compute!!
  const env = {
    Process: { Id: processId, Owner: processDef.owner, Tags: processDef.tags },
    Module: { Id: processDef, /* Owner: ctx.moduleOwner, Tags: ctx.moduleTags */ } // TODO
  }
  const memoryFinal = await evaluateMemory(moduleData, memoryInitial, evalMessages, env);

  if (memoryFinal === null) {
    logger.info(`Null memory for ${processId}`);
    return;
  }

  // Update the memory cache with the timestamp of the latest message
  const lastMessageTimestamp = evalMessages[evalMessages.length - 1].Timestamp;
  await processMemoryCache.cached(
    `${processId}-${lastMessageTimestamp}`,
    () => Promise.resolve(new Response(memoryFinal))
  );
  lastCachedProcessMemory.set(processId, parseInt(lastMessageTimestamp));
  
  // Clean up the old memory... after anyone might want to access it
  setTimeout(() => processMemoryCache.bust(`${processId}-${lastMemoryTimestamp}`), 10_000);
}

async function executeMessage(processId: string, message: AoLoader.Message): Promise<AoLoader.HandleResponse | null> {
  logger.info(`Querying process ${processId}`);
  
  const lastCachedProcessMemory = new Map<string, number>(); // Map(processId, lastEvaluatedMessageTs)
  if (!lastCachedProcessMemory) {
    logger.info(`Memory not found for ${processId}`);
    return null;
  }
  const memoryInitial = await processMemoryCache.cached<ArrayBuffer>(processId,(response) => response.arrayBuffer());
  if (!memoryInitial) throw Error(`Expected memory for ${processId}`);

  const processDef = await processDefCache.cached<ProcessDef>(processId, (response) => response.json());
  if (!processDef) throw Error(`Expected processDef for ${processId}`);
  const moduleResponse = await moduleDataCache.cached(processDef.moduleTxId);
  if (!moduleResponse) throw Error(`Expected moduleData for ${processDef.moduleTxId}`);

  const moduleData = await moduleResponse.arrayBuffer();
  const handle = await AoLoader(moduleData, { format: 'wasm32-unknown-emscripten2' });

  // TODO: env
  const env = {
    Process: { Id: processId, Owner: processDef.owner, Tags: processDef.tags },
    Module: { Id: processDef, /* Owner: ctx.moduleOwner, Tags: ctx.moduleTags */ } // TODO
  }
  const result = handle(memoryInitial, message, env);
  return result;
}

export async function handleProcessMessage(request: Request) {
  const processId = '' // TODO
  const message = {} as Message // TODO

  if (!lastCachedProcessMemory.has(processId)) {
    logger.warn(`No cached memory for ${processId}, forwarding request to ${request.url}`);
    return fetch(request)
  }

  const result = await executeMessage(processId, message);
  if (!result) {
    logger.warn(`No result for ${processId}, forwarding request to ${request.url}`);
    return fetch(request)
  }

  const { Memory, ...returnVals } = result;

  const calculatedResponse = new Response(JSON.stringify(returnVals))
  return calculatedResponse;
}
