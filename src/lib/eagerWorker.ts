/// <reference lib="webworker" />

import { ResponseKeyCache, WrappedResponseKeyCache } from "./cache";
import { evaluateMessages } from "./eval";
import { hashArrayBuffer } from "./hash";
import { ProcessDef } from "./model";
import { fetchModuleSourceRequest, fetchProcessDef, loadMessages } from "./result";
import AoLoader, { Message } from "@permaweb/ao-loader";

const logger = console;

const registeredProcesses = new Set<string>();

// Used by the updater to cache module data
const processDefCache = new WrappedResponseKeyCache('process-def');
const moduleDataCache = new ResponseKeyCache('module-data');

// Maintained by the updater & read by the evaluator
const lastCachedProcess = new Map<string, number>(); // Map(processId, lastEvaluatedMessageTs)
const processMemoryCache = new WrappedResponseKeyCache('process-memory');
const processMessagesCache = new WrappedResponseKeyCache('messages');

async function initializeCaches() {
  await Promise.all([
    processDefCache.init(),
    moduleDataCache.init(),
    processMemoryCache.init(),
    processMessagesCache.init(),
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
      await new Promise((resolve) => setTimeout(resolve, 1_000));
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

  const lastUpdateTimestamp = lastCachedProcess.get(processId);
  if (lastUpdateTimestamp) {
    logger.debug(`Getting memory from cache for ${processId}:${lastUpdateTimestamp}`);
    // Get memory from cache
    memoryInitial = await processMemoryCache.cached(
      `${processId}-${lastUpdateTimestamp}`,
      (response) => response.arrayBuffer(),
    );
    if (!memoryInitial) {
      logger.warn(`Memory not found in cache for ${processId}:${lastUpdateTimestamp}`);
      // Clear last cached memory & try again
      lastCachedProcess.delete(processId);
      return updateLocalProcess(processId);
    }
    // Get messages since last memory update
    const newMessages = await loadMessages(processDef.moduleTxId, processId, lastUpdateTimestamp);
    const oldMessages = await processMessagesCache.cached(
      processId,
      (response) => response.json(),
    );
    evalMessages = oldMessages.concat(newMessages);
  } else {
    // Start from empty memory
    memoryInitial = null;
    // Get all messages
    evalMessages = await loadMessages(processDef.moduleTxId, processId, 0);
  }

  // Update the messages cache
  console.info(`Updating messages cache for ${processId}`);
  await processMessagesCache.put(
    processId,
    evalMessages,
    (data) => Promise.resolve(new Response(JSON.stringify(data))),
  );

  if (evalMessages.length === 0) {
    logger.info(`No messages for ${processId}`);
    
    return;
  }
  
  // Run the compute!!
  const env = {
    Process: { Id: processId, Owner: processDef.owner, Tags: processDef.tags },
    Module: { Id: processDef, /* Owner: ctx.moduleOwner, Tags: ctx.moduleTags */ } // TODO
  }
  const memoryFinal = (await evaluateMessages(moduleData, memoryInitial, evalMessages, env))?.Memory;

  if (memoryFinal === null) {
    logger.warn(`Null memory for ${processId}`);
    return;
  }

  // Update the memory cache with the timestamp of the latest message
  const lastMessageTimestamp = evalMessages[evalMessages.length - 1].Timestamp;
  logger.info(`Updating memory cache for ${processId}:${lastMessageTimestamp} (SHA256: ${await hashArrayBuffer(memoryFinal)}`);
  await processMemoryCache.put<ArrayBuffer>(
    `${processId}-${lastMessageTimestamp}`,
    memoryFinal,
    (data) => Promise.resolve(new Response(data))
  );
  lastCachedProcess.set(processId, parseInt(lastMessageTimestamp));
  
  // Clean up the old memory... after anyone might want to access it
  // setTimeout(() => processMemoryCache.bust(`${processId}-${lastMemoryTimestamp}`), 10_000);
}

export async function executeMessage(processId: string, message: AoLoader.Message): Promise<AoLoader.HandleResponse | null> {
  logger.info(`Querying process ${processId}`);
  
  const lastUpdateTimestamp = lastCachedProcess.get(processId);
  if (!lastUpdateTimestamp) {
    logger.info(`Memory not found for ${processId}`);
    return null;
  } else {
    logger.info(`Memory found for ${processId}:${lastUpdateTimestamp}`);
  }
  const memoryInitial = await processMemoryCache.cached<ArrayBuffer>(
    `${processId}-${lastUpdateTimestamp}`,
    (response) => response.arrayBuffer(),
  );
  if (!memoryInitial) throw Error(`Expected memory for ${processId}`);
  logger.info(`Loaded memory cache for ${processId}:${lastUpdateTimestamp} (SHA256: ${await hashArrayBuffer(memoryInitial)}`);

  const previousMessages = await processMessagesCache.cached<Array<AoLoader.Message>>(
    processId,
    (response) => response.json(),
  );
  if (!previousMessages) throw Error(`Expected previous messages for ${processId}`);

  const processDef = await processDefCache.cached<ProcessDef>(processId, (response) => response.json());
  if (!processDef) throw Error(`Expected processDef for ${processId}`);
  const moduleResponse = await moduleDataCache.cached(processDef.moduleTxId);
  if (!moduleResponse) throw Error(`Expected moduleData for ${processDef.moduleTxId}`);

  const moduleData = await moduleResponse.arrayBuffer();
  // TODO: env
  const env = {
    Process: { Id: processId, Owner: processDef.owner, Tags: processDef.tags },
    Module: { Id: processDef, /* Owner: ctx.moduleOwner, Tags: ctx.moduleTags */ } // TODO
  }
  return await evaluateMessages(moduleData, null, previousMessages.concat([message]), env) ?? null;
}

export async function handleProcessMessage(request: Request) {
  const processId = '' // TODO
  const message = {} as Message // TODO

  if (!lastCachedProcess.has(processId)) {
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
