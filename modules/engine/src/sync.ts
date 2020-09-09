import { BigNumber } from "ethers";
import { Evt } from "evt";

import { ChannelUpdateError } from "./errors";
import {
  ChannelUpdate,
  MultisigCommitment,
  IStoreService,
  IMessagingService,
  VectorMessage,
  VectorChannelMessage,
  VectorErrorMessage,
  UpdateType,
  FullChannelState,
} from "./types";
import { delay, logger, isChannelMessage, isChannelState } from "./utils";
import { validate } from "./validate";
import { applyUpdate } from "./update";

// Function responsible for handling user-initated/outbound channel updates.
// These updates will be single signed, the function should dispatch the
// message to the counterparty, and resolve once the updated channel state
// has been persisted.
export async function outbound(
  update: ChannelUpdate,
  storeService: IStoreService,
  messagingService: IMessagingService,
  stateEvt: Evt<ChannelState>,
  errorEvt: Evt<ChannelUpdateError>,
): Promise<ChannelState> {
  const storedChannel = await storeService.getChannelState(update.channelAddress);
  if (!storedChannel) {
    // NOTE: IFF creating a channel, the initial channel state should be
    // created and saved using `generate` (i.e. before it gets to this
    // function call)
    throw new ChannelUpdateError(ChannelUpdateError.reasons.ChannelNotFound, update, storedChannel);
  }
  // Create a helper function that will create a function that properly
  // sets up the promise handlers. The only time this promise should
  // reject instead of resolve is if *sending* the message failed. In
  // that case, this should be safe to retry on failure
  const generatePromise = () =>
    new Promise<ChannelState | ChannelUpdateError>((resolve, reject) => {
      // If there is an error event corresponding to this channel and
      // this nonce, reject the promise
      errorEvt
        .pipe((e: ChannelUpdateError) => {
          return e.update.nonce === update.nonce && e.update.channelAddress === e.update.channelAddress;
        })
        .attachOnce((e: ChannelUpdateError) => resolve(e));

      // If there is a channel update event corresponding to
      // this channel update, resolve the promise
      stateEvt
        .pipe((e: ChannelState) => {
          return e.channelAddress === update.channelAddress && e.latestNonce === update.nonce;
        })
        .attachOnce((e: ChannelState) => resolve(e));

      // TODO: turn `update` into a DTO before sending?
      // TODO: what if there is no latest update?
      messagingService
        .send(update.counterpartyPublicIdentifier, { update, latestUpdate: storedChannel.latestUpdate })
        .catch((e) => reject(e.message));
    });

  // Retry sending the message 5 times w/3s delay
  const sendWithRetry = async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const _ of Array(5).fill(0)) {
      try {
        const result = await generatePromise();
        return result;
        // Otherwise, it is an error
      } catch (e) {
        logger.error(`Failed to execute helper`, { error: e.message, stack: e.stack });
        await delay(3_000);
      }
    }

    throw new ChannelUpdateError(ChannelUpdateError.reasons.MessageFailed, update, storedChannel);
  };

  const result = await sendWithRetry();
  if (isChannelState(result)) {
    // No error returned, successfully updated state
    return result;
  }

  // The only error we should handle and retry is the case where we
  // are one state behind
  if (result.message !== ChannelUpdateError.reasons.StaleUpdateNonce) {
    throw new ChannelUpdateError(result.message, update, storedChannel);
  }

  // We know we are out of sync with our counterparty, but we do not
  // know by how many updates. Only in the case where our proposed
  // update nonce == their latest update nonce

  // Make sure the update exists
  if (!result.state.latestUpdate) {
    throw new ChannelUpdateError(ChannelUpdateError.reasons.StaleChannelNonceNoUpdate, update, storedChannel);
  }

  // Make sure the update is the correct one
  if (result.state.latestUpdate.nonce !== update.nonce) {
    throw new ChannelUpdateError(ChannelUpdateError.reasons.StaleChannelNonce, update, storedChannel, {
      counterpartyLatestUpdate: result.state.latestUpdate,
    });
  }

  // Apply the update, and retry the update
  let newState: string | ChannelState;
  try {
    newState = await applyUpdate(result.state.latestUpdate, storedChannel);
  } catch (e) {
    newState = e.message;
  }
  if (typeof newState === "string") {
    throw new ChannelUpdateError(
      ChannelUpdateError.reasons.applyUpdateFailed,
      result.state.latestUpdate,
      storedChannel,
    );
  }

  // Save the updated state before retrying the update
  let error: string | undefined;
  try {
    await storeService.saveChannelState(newState);
  } catch (e) {
    error = e.message;
  }
  if (error) {
    throw new ChannelUpdateError(
      ChannelUpdateError.reasons.SaveChannelFailed,
      result.state.latestUpdate,
      storedChannel,
    );
  }

  // Retry the update
  const syncedResult = await sendWithRetry();
  if (!isChannelState(syncedResult)) {
    throw new ChannelUpdateError(syncedResult.message, update, newState);
  }
  return syncedResult;
}

// This function is responsible for handling any inbound vector messages.
// This function is expected to handle errors and updates from a counterparty.
export async function inbound(
  message: VectorMessage,
  storeService: IStoreService,
  messagingService: IMessagingService,
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  signer: any,
  stateEvt: Evt<ChannelState>,
  errorEvt: Evt<ChannelUpdateError>,
): Promise<void> {
  // If the message is from us, ignore
  if (message.from === signer.publicIdentifier) {
    return;
  }

  // If it is a response, process the response
  if (isChannelMessage(message)) {
    return processChannelMessage(message, storeService, messagingService, signer, stateEvt, errorEvt);
  }

  // It is an error message from a counterparty. An `outbound` promise
  // may be waiting to resolve, so post to th errorEvt
  // TODO we should not assume here that any non-channel-message is an error message(!!)
  errorEvt.post((message as VectorErrorMessage).error);
}

// This function is responsible for handling any inbound state requests.
async function processChannelMessage(
  message: VectorChannelMessage,
  storeService: IStoreService,
  messagingService: IMessagingService,
  signer: any,
  stateEvt: Evt<ChannelState>,
  errorEvt: Evt<ChannelUpdateError>,
): Promise<void> {
  const { from, data } = message;
  const requestedUpdate = data.update as ChannelUpdate;
  const counterpartyLatestUpdate = data.latestUpdate as ChannelUpdate;
  // Create helper to handle errors
  const handleError = async (error: ChannelUpdateError) => {
    // If the update is single signed, the counterparty is waiting
    // for a response.
    if (requestedUpdate.commitment.signatures.length === 1) {
      await messagingService.send(from, error);
    }
    // Post to the evt
    errorEvt.post(error);
    // If the update is double signed, the counterparty is not
    // waiting for a response and it is safe to error
    throw error;
  };

  // Get our latest stored state
  let storedState: ChannelState = await storeService.getChannelState(requestedUpdate.channelAddress);
  if (!storedState) {
    // NOTE: the creation update MUST have a nonce of 1 not 0!
    // You may not be able to find a channel state IFF the channel is
    // being created for the first time. If this is the case, create an
    // empty channel and continue through the function
    if (requestedUpdate.type !== UpdateType.setup) {
      return handleError(
        new ChannelUpdateError(ChannelUpdateError.reasons.ChannelNotFound, requestedUpdate, storedState),
      );
    }
    // Create an empty channel state
    storedState = {
      channelAddress: requestedUpdate.channelAddress,
      participants: [requestedUpdate.counterpartyPublicIdentifier, signer.publicIdentifier],
      chainId: (await signer.provider.getNetwork()).chainId,
      latestNonce: "0",
      latestUpdate: undefined,
    };
  }

  // Assume that our stored state has nonce `k`, and the update
  // has nonce `n`, and `k` is the latest double signed state for you. The
  // following cases exist:
  // - n < k - 2: counterparty is behind, they must restore
  // - n == k - 1: counterparty is behind, they will sync and recover, we
  //   can ignore update
  // - n == k, single signed: counterparty is behind, ignore update
  // - n == k, double signed:
  //    - IFF the states are the same, the counterparty is behind
  //    - IFF the states are different and signed at the same nonce,
  //      that is VERY bad, and should NEVER happen
  // - n == k + 1, single signed: counterparty proposing an update,
  //   we should verify, store, + ack
  // - n == k + 1, double signed: counterparty acking our update,
  //   we should verify, store, + emit
  // - n == k + 2: counterparty is proposing or acking on top of a
  //   state we do not yet have, sync state + apply update
  // - n >= k + 3: we must restore state

  // NOTE: by including the proposed update and the latest update, we are
  // able to automatically recover within the `inbound` function if we
  // are behind. There is an argument to be made that any syncing of
  // state and not explicitly progressing of state should be handled
  // outside of this function

  // Before proceeding, verify any signatures present are correct
  try {
    await requestedUpdate.commitment.assertSignatures();
    // TODO: should also make sure that there are *2* signatures
    await counterpartyLatestUpdate.commitment.assertSignatures();
  } catch (e) {
    return handleError(
      new ChannelUpdateError(ChannelUpdateError.reasons.BadSignatures, requestedUpdate, storedState, {
        counterpartyLatestUpdate,
        error: e.message,
      }),
    );
  }

  // Get the difference between the stored and received nonces
  const diff = BigNumber.from(requestedUpdate.nonce).sub(storedState.latestNonce);

  // If we are ahead, or even, do not process update
  if (diff.lte(0)) {
    // NOTE: when you are out of sync as a protocol initiator, you will
    // use the information from this error to sync, then retry your update

    // FIXME: We don't need to pass everything over the wire here, fix that
    return handleError(
      new ChannelUpdateError(ChannelUpdateError.reasons.StaleUpdateNonce, requestedUpdate, storedState, {
        counterpartyLatestUpdate,
      }),
    );
  }

  // If we are behind by more than 3, we cannot sync from their latest
  // update, and must use restore
  if (diff.gte(3)) {
    return handleError(
      new ChannelUpdateError(ChannelUpdateError.reasons.StaleChannelNonce, requestedUpdate, storedState, {
        counterpartyLatestUpdate,
      }),
    );
  }

  // If the update nonce is ahead of the store nonce by 2, we are
  // behind by one update. We can progress the state to the correct
  // state to be updated by applying the counterparty's supplied
  // latest action
  let previousState = storedState;
  if (diff.eq(2)) {
    // Create the proper state to play the update on top of using the
    // latest update
    if (!counterpartyLatestUpdate) {
      return handleError(
        new ChannelUpdateError(
          ChannelUpdateError.reasons.StaleChannelNonceNoUpdate,
          counterpartyLatestUpdate,
          storedState,
          { requestedUpdate },
        ),
      );
    }
    try {
      previousState = await applyUpdate(counterpartyLatestUpdate, storedState);
    } catch (e) {
      return handleError(
        new ChannelUpdateError(ChannelUpdateError.reasons.applyUpdateFailed, counterpartyLatestUpdate, storedState, {
          requestedUpdate,
          error: e.message,
          stack: e.stack,
        }),
      );
    }
  }

  // We now have the latest state for the update, and should be
  // able to play it on top of the update
  let response: ChannelState | string;
  try {
    response = await applyUpdate(requestedUpdate, previousState);
  } catch (e) {
    response = e.message;
  }
  if (typeof response === "string") {
    return handleError(
      new ChannelUpdateError(ChannelUpdateError.reasons.applyUpdateFailed, requestedUpdate, previousState, {
        counterpartyLatestUpdate,
        error: response,
      }),
    );
  }

  // If the update was single signed, the counterparty is proposing
  // an update, so we should return an ack
  if (requestedUpdate.commitment.signatures.length === 1) {
    // Sign the update
    let signed: MultisigCommitment;
    try {
      const sig = await signer.signMessage(requestedUpdate.commitment.getHash());
      signed = requestedUpdate.commitment.addSignature(sig);
      await storeService.saveChannelState(response);
    } catch (e) {
      return handleError(
        new ChannelUpdateError(ChannelUpdateError.reasons.SaveChannelFailed, requestedUpdate, previousState, {
          error: e.message,
        }),
      );
    }

    // Send the latest update to the node
    await messagingService.send(from, {
      update: { ...requestedUpdate, commitment: signed },
      latestUpdate: response.latestUpdate,
    });
    return;
  }

  // Otherwise, we are receiving an ack, and we should save the
  // update to store and post to the EVT
  try {
    await storeService.saveChannelState(response);
  } catch (e) {
    return handleError(
      new ChannelUpdateError(ChannelUpdateError.reasons.SaveChannelFailed, requestedUpdate, previousState, {
        error: e.message,
      }),
    );
  }
  stateEvt.post(response);
}