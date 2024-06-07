/// <reference lib="webworker" />
// Original: https://github.com/warp-contracts/ao-cu/blob/main/src/routes/result.mjs

import { Mutex } from "async-mutex";
import { Tag } from "./model";
import Transaction from "arweave/node/lib/transaction";
import AoLoader from '@permaweb/ao-loader';

const logger = console
const suUrl = "https://su-router.ao-testnet.xyz";

const handlersCache = new Map();
const prevResultCache = new Map();
const mutexes = new Map();

const Benchmark = {
  measure: () => {
    const start = Date.now()
    return {
      elapsed: () => {
        return Date.now() - start
      }
    }
  }
}

export async function resultRoute(request: Request, response: Response) {
  const benchmark = Benchmark.measure();

  const messageId = request.path_parameters["message-identifier"];
  const processId = request.query_parameters["process-id"];
  if (!mutexes.has(processId)) {
    logger.debug(`Storing mutex for ${processId}`);
    mutexes.set(processId, new Mutex());
  }
  const mutex = mutexes.get(processId);
  if (mutex.isLocked()) {
    logger.debug(`Mutex for ${processId} locked`);
    await mutex.waitForUnlock();
  }
  logger.debug(`Mutex for ${processId} unlocked, acquiring`);
  const releaseMutex = await mutex.acquire();
  try {
    const result = await doReadResult(processId, messageId);
    logger.info(`Result for ${processId}::${messageId} calculated in ${benchmark.elapsed()}`);
    return response.json(result);
  } catch (e) {
    logger.error(e);
  } finally {
    logger.debug(`Releasing mutex for ${processId}`);
    releaseMutex();
  }
}

async function doReadResult(processId: string, messageId: string) {
  const messageBenchmark = Benchmark.measure();
  const message = await fetchMessageData(messageId, processId);
  logger.info(`Fetching message info ${messageBenchmark.elapsed()}`);
  // note: this effectively skips the initial process message -
  // which in AO is considered as a 'constructor' - we do not need it now
  if (message === null) {
    logger.info('Initial process message - skipping');
    return {
      Error: '',
      Messages: [],
      Spawns: [],
      Assignments: [],
      Output: null,
      Memory: undefined,
    };
  }
  const nonce = message.Nonce;
  logger.info({messageId, processId, nonce});

  const isFirstMessage = false // TODO
  if (isFirstMessage) {
    logger.debug('First message for the process');
    const initialMemory = handlersCache.get(processId).def.initialMemory;
    const result = await doEvalMemory(messageId, processId, message, initialMemory);
    prevResultCache.set(processId, {
      messageId,
      nonce,
      timestamp: message.Timestamp,
      result
    });
    return result;
  }

  if (cachedResult) {
    // (1) exact match = someone requested the same Memory twice?
    if (cachedResult.nonce === nonce) {
      logger.trace(`cachedResult.nonce === message.Nonce`);
      logger.debug(`Exact match for nonce ${message.Nonce}`);
      await publish(message, cachedResult.result, processId, messageId);
      return cachedResult.result
    }

    // (2) most probable case - we need to evaluate the result for the new message,
    // and we have a result cached for the exact previous message
    if (cachedResult.nonce === nonce - 1) {
      logger.trace(`cachedResult.nonce === message.Nonce - 1`);
      const result = await doEvalMemory(messageId, processId, message, cachedResult.result.Memory, true);
      prevResultCache.set(processId, {
        messageId,
        nonce,
        timestamp: message.Timestamp,
        result
      });
      return result;
    }

    // (3) for some reason evaluation for some messages was skipped, and
    // we need to first load all the missing messages(cachedResult.nonce, message.Nonce> from the SU.
    if (cachedResult.nonce < nonce - 1) {
      logger.trace(`cachedResult.nonce < message.Nonce - 1`);
      const messages = await loadMessages(processId, cachedResult.timestamp, message.Timestamp);
      const {result, lastMessage} = await evalMessages(processId, messages, cachedResult.result.Memory);
      prevResultCache.set(processId, {
        messageId: lastMessage.Id,
        nonce: lastMessage.Nonce,
        timestamp: lastMessage.Timestamp,
        result
      });
      return result;
    }

    if (cachedResult.nonce > nonce) {
      logger.trace(`cachedResult.nonce > message.Nonce`);
      logger.warn(`${messageId} for ${processId} already evaluated, returning from L2 cache`);
      const result = await getForMsgId({processId, messageId});
      if (!result) {
        throw new Error(`Result for $${processId}:${messageId}:${nonce} not found in L2 cache`);
      }
      return result;
    }
  } else {
    logger.debug('ChachedResult null');
    const messages = await loadMessages(processId, 0, message.Timestamp);
    const initialMemory = handlersCache.get(processId).def.initialMemory;
    const {result, lastMessage} = await evalMessages(processId, messages, initialMemory);
    prevResultCache.set(processId, {
      messageId: lastMessage.Id,
      nonce: lastMessage.Nonce,
      timestamp: lastMessage.Timestamp,
      result
    });
    return result;
  }
}

async function evalMessages(processId: string, messages: Array<AoLoader.Message>, prevMemory: Uint8Array) {
  const messagesLength = messages.length;
  if (messagesLength === 0) {
    return {
      Error: '',
      Messages: [],
      Spawns: [],
      Assignments: [],
      Output: null,
      Memory: prevMemory
    };
  }
  let result;
  let lastMessage;
  for (let i = 0; i < messagesLength; i++) {
    lastMessage = parseMessagesData(messages[i].node, processId);
    result = await doEvalMemory(lastMessage.Id, processId, lastMessage, prevMemory);
    prevMemory = result.Memory;
  }

  await storeResultInDb(processId, lastMessage.Id, lastMessage, result);

  return {
    lastMessage,
    result
  };
}

async function doEvalMemory(messageId: string, processId: string, message, prevMemory) {
  logger.debug(`Eval for ${processId}:${messageId}:${message.Nonce}`);
  const calculationBenchmark = Benchmark.measure();
  const result = await handlersCache.get(processId).api.handle(message, prevMemory);
  logger.info(`Calculating ${calculationBenchmark.elapsed()}`);

  return {
    Error: result.Error,
    Messages: result.Messages,
    Spawns: result.Spawns,
    Output: result.Output,
    Memory: result.Memory,
    Assignments: []
  };
}

export async function fetchProcessDef(processId: string) {
  logger.trace('Before process def fetch');
  const response = await fetch(`${suUrl}/processes/${processId}`);
  logger.trace('After process def fetch');
  if (response.ok) {
    logger.trace('Process def fetch ok');
    return parseProcessData(await response.json());
  } else {
    throw new Error(`${response.status}: ${response.statusText}`);
  }
}

export async function parseProcessData(message: Transaction) {
  return {
    block: message.block,
    owner: message.owner,
    timestamp: message.timestamp,
    tags: message.tags,
    moduleTxId: tagValue(message.tags, 'Module')!,
  }
}

export async function fetchModuleSourceRequest(moduleTxId: string) {
  const response = await fetch(`https://arweave.net/${moduleTxId}`);
  if (response.ok) {
    return response;
  } else {
    throw new Error(`${response.status}: ${response.statusText}`);
  }
}

export async function fetchMessageData(messageId: string, moduleId: string, processId: string) {
  logger.debug(`Loading message ${messageId} for process ${processId}`);
  const response = await fetch(`${suUrl}/${messageId}?process-id=${processId}`);
  if (response.ok) {
    const input = await response.json();
    return parseMessagesData(input, moduleId, processId);
  } else {
    throw new Error(`${response.status}: ${response.statusText}`);
  }
}

export function parseMessagesData(input: MessageRaw, moduleId: string, processId: string) {
  const {message, assignment} = input;

  const type = tagValue(message.tags, 'Type');
  logger.debug(`Message ${message.id} type: ${type}`);
  if (type === 'Process') {
    logger.debug("Process deploy message");
    logger.debug("=== message ===");
    logger.debug(message);
    logger.debug("=== assignment ===");
    logger.debug(assignment);
    return null;
  }
  return {
    "Module": moduleId,
    "Id": message.id,
    "Signature": message.signature,
    "Data": message.data,
    "Owner": message.owner.address,
    "Target": processId,
    "Anchor": null,
    "From": processId,
    "Forwarded-By": message.owner.address,
    "Tags": message.tags.concat(assignment.tags),
    "Epoch": parseInt(tagValue(assignment.tags, 'Epoch')!),
    "Nonce": parseInt(tagValue(assignment.tags, 'Nonce')!),
    "Timestamp": parseInt(tagValue(assignment.tags, 'Timestamp')!),
    "Block-Height": parseInt(tagValue(assignment.tags, 'Block-Height')!),
    "Hash-Chain": parseInt(tagValue(assignment.tags, 'Hash-Chain')!),
    "Cron": false,
    "Read-Only": false
  }
}

// TODO: lame implementation "for now", stream messages, or at least whole pages.
export async function loadMessages(moduleId: string, processId: string, fromExclusive: number, toInclusive?: number): Promise<Array<MessageRaw>> {
  const benchmark = Benchmark.measure();
  const result = [];
  logger.info(`Loading messages from su ${processId}:${fromExclusive}:${toInclusive}`);
  let hasNextPage = true;
  while (hasNextPage) {
    const url = toInclusive === undefined
      ? `${suUrl}/${processId}?from=${fromExclusive}`
      : `${suUrl}/${processId}?from=${fromExclusive}&to=${toInclusive}`;
    logger.trace(url);
    const response = await fetch(url);
    if (response.ok) {
      const pageResult = await response.json();
      result.push(...pageResult.edges);
      hasNextPage = pageResult.page_info.has_next_page;
      if (hasNextPage) {
        fromExclusive = result[result.length - 1].cursor;
        logger.debug(`New from ${fromExclusive}`);
      }
    } else {
      throw new Error(`${response.status}: ${response.statusText}`);
    }
  }
  logger.debug(`Messages loaded in: ${benchmark.elapsed()}`);
  logger.info(`Found ${result.length} messages for ${processId}`);
  logger.debug(result)

  logger.debug(`Parsing Raw Messages`)
  const messages = result.map((message) => parseMessagesData(message.node, moduleId, processId))
  logger.debug(messages)

  return messages;
}

export function tagValue(tags: Tag[], name: string) {
  const tag =  tags.find((tag) => tag.name === name);
  return tag ? tag.value : null;
}
