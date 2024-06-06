// Source: https://github.com/warp-contracts/ao-cu/blob/main/src/routes/result.mjs
import {getLogger} from "../logger.mjs";
import {QuickJsPlugin} from 'warp-contracts-plugin-quickjs';
import {tagValue} from "../tools.mjs";
import {initPubSub as initAppSyncPublish, publish as appSyncPublish} from 'warp-contracts-pubsub'
import {getForMsgId, getLessOrEq, insertResult} from "../db.mjs";
import {Benchmark} from "warp-contracts";
import {Mutex} from "async-mutex";
import {broadcast_message} from "./sse.mjs";

initAppSyncPublish()

const logger = getLogger("resultRoute", "trace");
const suUrl = "http://127.0.0.1:9000";

const handlersCache = new Map();
const prevResultCache = new Map();
const mutexes = new Map();

export async function resultRoute(request, response) {
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

async function doReadResult(processId, messageId) {
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
      State: {}
    };
  }
  const nonce = message.Nonce;
  logger.info({messageId, processId, nonce});
  if (!handlersCache.has(processId)) {
    await cacheProcessHandler(processId);
  }
  logger.info('Process handler cached');

  logger.debug('Checking cached result in L1 cache');
  // first try to load from the in-memory cache...
  let cachedResult = prevResultCache.get(processId);
  // ...fallback to L2 (DB) cache
  if (!cachedResult) {
    logger.debug('Checking cached result in L2 cache');
    cachedResult = await getLessOrEq({processId, nonce});
  }

  if (nonce === 0 && !cachedResult) {
    logger.debug('First message for the process');
    const initialState = handlersCache.get(processId).def.initialState;
    const result = await doEvalState(messageId, processId, message, initialState, true);
    prevResultCache.set(processId, {
      messageId,
      nonce,
      timestamp: message.Timestamp,
      result
    });
    return result;
  }

  if (cachedResult) {
    // (1) exact match = someone requested the same state twice?
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
      const result = await doEvalState(messageId, processId, message, cachedResult.result.State, true);
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
      const {result, lastMessage} = await evalMessages(processId, messages, cachedResult.result.State);
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
    const initialState = handlersCache.get(processId).def.initialState;
    const {result, lastMessage} = await evalMessages(processId, messages, initialState);
    prevResultCache.set(processId, {
      messageId: lastMessage.Id,
      nonce: lastMessage.Nonce,
      timestamp: lastMessage.Timestamp,
      result
    });
    return result;
  }
}

async function evalMessages(processId, messages, prevState) {
  const messagesLength = messages.length;
  if (messagesLength === 0) {
    return {
      Error: '',
      Messages: [],
      Spawns: [],
      Assignments: [],
      Output: null,
      State: prevState
    };
  }
  let result;
  let lastMessage;
  for (let i = 0; i < messagesLength; i++) {
    lastMessage = parseMessagesData(messages[i].node, processId);
    result = await doEvalState(lastMessage.Id, processId, lastMessage, prevState, false);
    prevState = result.State;
  }

  await publish(lastMessage, result, processId, lastMessage.Id);
  // do not await in order not to slow down the processing
  await storeResultInDb(processId, lastMessage.Id, lastMessage, result);

  return {
    lastMessage,
    result
  };
}

async function doEvalState(messageId, processId, message, prevState, store) {
  logger.debug(`Eval for ${processId}:${messageId}:${message.Nonce}`);
  const calculationBenchmark = Benchmark.measure();
  const result = await handlersCache.get(processId).api.handle(message, prevState);
  logger.info(`Calculating ${calculationBenchmark.elapsed()}`);

  if (store) {
    // this one needs to by synced, in order to retain order from the clients' perspective
    await publish(message, result, processId, messageId);

    // do not await in order not to slow down the processing
    await storeResultInDb(processId, messageId, message, result);
  }

  return {
    Error: result.Error,
    Messages: result.Messages,
    Spawns: result.Spawns,
    Output: result.Output,
    State: result.State,
    Assignments: []
  };
}

async function cacheProcessHandler(processId) {
  logger.info('Process handler not cached', processId);
  const processDefinition = await fetchProcessDef(processId);
  const quickJsPlugin = new QuickJsPlugin({});
  const quickJsHandlerApi = await quickJsPlugin.process({
    contractSource: processDefinition.moduleSource,
    binaryType: 'release_sync'
  })
  handlersCache.set(processId, {
    api: quickJsHandlerApi,
    def: processDefinition
  });
}

async function publish(message, result, processId, messageId) {

  const messageToPublish = JSON.stringify({
    txId: messageId,
    nonce: message.Nonce,
    output: result.Output,
    state: result.State,
    tags: message.Tags,
    sent: new Date()
  });

  //broadcast_message(processId, messageToPublish);
  return appSyncPublish(
    `results/ao/${message.Target}`,
    messageToPublish,
    process.env.APPSYNC_KEY
  ).then(() => {
    logger.debug(`Result for ${processId}:${messageId}:${message.Nonce} published`);
  }).catch((e) => {
    logger.error(e);
  });
}

async function storeResultInDb(processId, messageId, message, result) {
  try {
    await insertResult({processId, messageId, result, nonce: message.Nonce, timestamp: message.Timestamp});
    logger.debug(`Result for ${processId}:${messageId}:${message.Nonce} stored in db`);
  } catch (e) {
    logger.error(e);
  }
}

async function fetchProcessDef(processId) {
  logger.trace('Before process def fetch');
  const response = await fetch(`${suUrl}/processes/${processId}`);
  logger.trace('After process def fetch');
  if (response.ok) {
    logger.trace('Process def fetch ok');
    return parseProcessData(await response.json());
  } else {
    throw new Error(`${response.statusCode}: ${response.statusMessage}`);
  }
}

async function parseProcessData(message) {
  // TODO: check whether module and process were deployed from our "jnio" wallet
  if (message.owner.address !== "jnioZFibZSCcV8o-HkBXYPYEYNib4tqfexP0kCBXX_M") {
    logger.error(`Only processes from "jnioZFibZSCcV8o-HkBXYPYEYNib4tqfexP0kCBXX_M" address are allowed, used: ${message.owner.address}`);
    throw new Error(`Only processes from "jnioZFibZSCcV8o-HkBXYPYEYNib4tqfexP0kCBXX_M" address are allowed`);
  }
  const moduleTxId = tagValue(message.tags, 'Module');
  return {
    block: message.block,
    owner: message.owner,
    timestamp: message.timestamp,
    initialState: JSON.parse(message.data),
    moduleTxId: tagValue(message.tags, 'Module'),
    moduleSource: await fetchModuleSource(moduleTxId)
  }
}

async function fetchModuleSource(moduleTxId) {
  const response = await fetch(`https://arweave.net/${moduleTxId}`);
  if (response.ok) {
    return await response.text();
  } else {
    throw new Error(`${response.statusCode}: ${response.statusMessage}`);
  }
}

async function fetchMessageData(messageId, processId) {
  /*
  // turns out it is also slow AF....
  if (timestamp) {
    // some low-level optimization to use the messages endpoint (which currently responds
    // faster than the single message endpoint)
    logger.debug(`Trying to fetch from 'messages' endpoint.`);
    const url = `${suUrl}/${processId}?from=${timestamp}&to=${timestamp + 60000}`;
    logger.trace(url);
    const response = await fetch(url);
    if (response.ok) {
      const result = await response.json();
      if (result.edges?.length && result.edges[0].node.message.id === messageId) {
        logger.debug("Returning message data from the 'messages' endpoint");
        return parseMessagesData(result.edges[0].node, processId);
      }
    } else {
      throw new Error(`${response.statusCode}: ${response.statusMessage}`);
    }
  }*/
  logger.debug(`Loading message ${messageId} for process ${processId}`);
  const response = await fetch(`${suUrl}/${messageId}?process-id=${processId}`);
  if (response.ok) {
    const input = await response.json();
    return parseMessagesData(input, processId);
  } else {
    throw new Error(`${response.statusCode}: ${response.statusMessage}`);
  }
}

function parseMessagesData(input, processId) {
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
    "Id": message.id,
    "Signature": message.signature,
    "Data": message.data,
    "Owner": message.owner.address,
    "Target": processId,
    "Anchor": null,
    "From": processId,
    "Forwarded-By": message.owner.address,
    "Tags": message.tags.concat(assignment.tags),
    "Epoch": parseInt(tagValue(assignment.tags, 'Epoch')),
    "Nonce": parseInt(tagValue(assignment.tags, 'Nonce')),
    "Timestamp": parseInt(tagValue(assignment.tags, 'Timestamp')),
    "Block-Height": parseInt(tagValue(assignment.tags, 'Block-Height')),
    "Hash-Chain": parseInt(tagValue(assignment.tags, 'Hash-Chain')),
    "Cron": false,
    "Read-Only": false
  }
}

// TODO: lame implementation "for now", stream messages, or at least whole pages.
async function loadMessages(processId, fromExclusive, toInclusive) {
  const benchmark = Benchmark.measure();
  const result = [];
  logger.info(`Loading messages from su ${processId}:${fromExclusive}:${toInclusive}`);
  let hasNextPage = true;
  while (hasNextPage) {
    const url = `${suUrl}/${processId}?from=${fromExclusive}&to=${toInclusive}`;
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
      throw new Error(`${response.statusCode}: ${response.statusMessage}`);
    }
  }
  logger.debug(`Messages loaded in: ${benchmark.elapsed()}`);
  logger.info(`Found ${result.length} messages for ${processId}`);

  return result;
}