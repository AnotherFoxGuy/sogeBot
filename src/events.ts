import { setTimeout } from 'timers'; // tslint workaround

import { EventList as EventListEntity } from '@entity/eventList.js';
import { Request } from 'express';
import {
  clone, cloneDeep, get, isNil, random, sample, orderBy,
} from 'lodash-es';
import { VM }  from 'vm2';

import { Delete, Get, Post } from './decorators/endpoint.js';
import { dayjs } from './helpers/dayjsHelper.js';
import { generateUsername } from './helpers/generateUsername.js';
import { getLocalizedName } from './helpers/getLocalizedName.js';
import getNameById from './helpers/user/getNameById.js';
import { Types } from './plugins/ListenTo.js';
import twitch from './services/twitch.js';

import Core from '~/_interface.js';
import { parserReply } from '~/commons.js';
import {
  Attributes, Event, Operations,
} from '~/database/entity/event.js';
import { User } from '~/database/entity/user.js';
import { AppDataSource } from '~/database.js';
import { onStreamEnd } from '~/decorators/on.js';
import events from '~/events.js';
import { isStreamOnline, rawStatus, stats, streamStatusChangeSince } from '~/helpers/api/index.js';
import { attributesReplace } from '~/helpers/attributesReplace.js';
import {
  announce, getOwner, getUserSender, isUUID, prepare,
} from '~/helpers/commons/index.js';
import { mainCurrency } from '~/helpers/currency/index.js';
import {
  getAll, getValueOf, setValueOf,
} from '~/helpers/customvariables/index.js';
import { isDbConnected } from '~/helpers/database.js';
import { eventEmitter } from '~/helpers/events/emitter.js';
import { fireRunCommand } from '~/helpers/events/run-command.js';
import emitter from '~/helpers/interfaceEmitter.js';
import {
  debug, error, info, warning,
} from '~/helpers/log.js';
import { tmiEmitter } from '~/helpers/tmi/index.js';
import * as changelog from '~/helpers/user/changelog.js';
import {
  isOwner, isSubscriber, isVIP,
} from '~/helpers/user/index.js';
import { isBot, isBotSubscriber } from '~/helpers/user/isBot.js';
import { isBroadcaster } from '~/helpers/user/isBroadcaster.js';
import { isModerator } from '~/helpers/user/isModerator.js';
import { createClip } from '~/services/twitch/calls/createClip.js';
import { getCustomRewards } from '~/services/twitch/calls/getCustomRewards.js';
import { getIdFromTwitch } from '~/services/twitch/calls/getIdFromTwitch.js';
import { updateChannelInfo } from '~/services/twitch/calls/updateChannelInfo.js';
import { variables } from '~/watchers.js';

const excludedUsers = new Set<string>();

class Events extends Core {
  public timeouts: { [x: string]: NodeJS.Timeout } = {};
  public supportedEventsList: {
    id: string;
    variables?: string[];
    check?: (event: Event, attributes: any) => Promise<boolean>;
    definitions?: {
      [x: string]: any;
    };
  }[];
  public supportedOperationsList: {
    id: string;
    definitions?: {
      [x: string]: any;
    };
    fire: (operation: Operations['definitions'], attributes: Attributes) => Promise<any>;
  }[];

  constructor() {
    super();

    this.supportedEventsList = [
      { id:        'commercial', variables: [
        'duration',
        'startedAt',
        'isAutomatic',
        'broadcasterDisplayName',
        'broadcasterId',
        'broadcasterName',
        'requesterDisplayName',
        'requesterId',
        'requesterName',
      ] },
      { id:        'shoutout-created', variables: [
        'broadcasterDisplayName',
        'broadcasterId',
        'broadcasterName',
        'shoutedOutBroadcasterDisplayName',
        'shoutedOutBroadcasterId',
        'shoutedOutBroadcasterName',
        'viewerCount' ] },
      { id:        'shoutout-received', variables: [
        'broadcasterDisplayName',
        'broadcasterId',
        'broadcasterName',
        'viewerCount',
        'shoutingOutBroadcasterDisplayName',
        'shoutingOutBroadcasterId',
        'shoutingOutBroadcasterName',
      ] },
      { id: 'prediction-started', variables: [ 'titleOfPrediction', 'outcomes', 'locksAt' ] },
      { id: 'prediction-locked', variables: [ 'titleOfPrediction', 'outcomes', 'locksAt' ] },
      { id: 'prediction-ended', variables: [ 'titleOfPrediction', 'outcomes', 'locksAt', 'winningOutcomeTitle', 'winningOutcomeTotalPoints', 'winningOutcomePercentage' ] },
      { id: 'poll-started', variables: [ 'titleOfPoll', 'choices', 'bitVotingEnabled', 'bitAmountPerVote', 'channelPointsVotingEnabled', 'channelPointsAmountPerVote' ] },
      { id: 'poll-ended', variables: [ 'titleOfPoll', 'choices', 'votes', 'winnerVotes', 'winnerPercentage', 'winnerChoice' ] },
      { id: 'hypetrain-started', variables: [ ] },
      { id: 'hypetrain-ended', variables: [ 'level', 'total', 'goal', 'topContributionsBitsUserId', 'topContributionsBitsUsername', 'topContributionsBitsTotal', 'topContributionsSubsUserId', 'topContributionsSubsUsername', 'topContributionsSubsTotal', 'lastContributionType', 'lastContributionUserId', 'lastContributionUsername', 'lastContributionTotal' ] },
      { id: 'hypetrain-level-reached', variables: [ 'level', 'total', 'goal', 'topContributionsBitsUserId', 'topContributionsBitsUsername', 'topContributionsBitsTotal', 'topContributionsSubsUserId', 'topContributionsSubsUsername', 'topContributionsSubsTotal', 'lastContributionType', 'lastContributionUserId', 'lastContributionUsername', 'lastContributionTotal' ] },
      { id: 'user-joined-channel', variables: [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner' ] },
      { id: 'user-parted-channel', variables: [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner' ] },
      {
        id: 'number-of-viewers-is-at-least-x', variables: [ 'count' ], definitions: { viewersAtLeast: 100, runInterval: 0 }, check: this.checkNumberOfViewersIsAtLeast,
      }, // runInterval 0 or null - disabled; > 0 every x seconds
      {
        id: 'stream-is-running-x-minutes', definitions: { runAfterXMinutes: 100 }, check: this.checkStreamIsRunningXMinutes,
      },
      { id: 'mod', variables: [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner' ] },
      { id: 'timeout', variables: [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner', 'duration' ] },
      {
        id: 'reward-redeemed', definitions: { rewardId: '' }, variables: [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner', 'userInput' ], check: this.isCorrectReward,
      },
      {
        id:          'command-send-x-times', variables:   [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner', 'command', 'count', 'source' ], definitions: {
          fadeOutXCommands: 0, fadeOutInterval: 0, runEveryXCommands: 10, commandToWatch: '', runInterval: 0,
        }, check: this.checkCommandSendXTimes,
      }, // runInterval 0 or null - disabled; > 0 every x seconds
      { id: 'chatter-first-message', variables: [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner', 'source' ] },
      {
        id:          'keyword-send-x-times', variables:   [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner', 'command', 'count', 'source' ], definitions: {
          fadeOutXKeywords: 0, fadeOutInterval: 0, runEveryXKeywords: 10, keywordToWatch: '', runInterval: 0, resetCountEachMessage: false,
        }, check: this.checkKeywordSendXTimes,
      }, // runInterval 0 or null - disabled; > 0 every x seconds
      { id: 'action', variables: [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner' ] },
      { id: 'ban', variables: [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner', 'reason' ] },
      { id: 'cheer', variables: [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner', 'bits', 'message' ] },
      { id: 'clearchat' },
      { id: 'game-changed', variables: [ 'oldGame', 'game' ] },
      { id: 'stream-started' },
      { id: 'stream-stopped' },
      { id: 'follow', variables: [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner' ] },
      { id: 'subscription', variables: [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner', 'method', 'subCumulativeMonths', 'tier' ] },
      { id: 'subgift', variables: [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner', 'recipient', 'recipientis.moderator', 'recipientis.subscriber', 'recipientis.vip', 'recipientis.broadcaster', 'recipientis.bot', 'recipientis.owner', 'tier' ] },
      { id: 'subcommunitygift', variables: [ 'username', 'count', 'tier' ] },
      { id: 'resub', variables: [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner', 'subStreakShareEnabled', 'subStreak', 'subStreakName', 'subCumulativeMonths', 'subCumulativeMonthsName', 'tier', 'message' ] },
      { id: 'tip', variables: [ 'username', 'amount', 'currency', 'message', 'amountInBotCurrency', 'currencyInBot' ] },
      {
        id: 'raid', variables: [ 'username', 'is.moderator', 'is.subscriber', 'is.vip', 'is.broadcaster', 'is.bot', 'is.owner', 'hostViewers' ], definitions: { viewersAtLeast: 1 }, check: this.checkRaid,
      },
      {
        id: 'every-x-minutes-of-stream', definitions: { runEveryXMinutes: 100 }, check: this.everyXMinutesOfStream,
      },
    ];

    this.supportedOperationsList = [
      {
        id: 'send-chat-message', definitions: { messageToSend: '' }, fire: this.fireSendChatMessage,
      },
      {
        id: 'send-whisper', definitions: { messageToSend: '' }, fire: this.fireSendWhisper,
      },
      {
        id: 'run-command', definitions: { commandToRun: '', isCommandQuiet: false, timeout: 0, timeoutType: ['normal', 'add', 'reset'] }, fire: fireRunCommand,
      },
      {
        id: 'emote-explosion', definitions: { emotesToExplode: '' }, fire: this.fireEmoteExplosion,
      },
      {
        id: 'emote-firework', definitions: { emotesToFirework: '' }, fire: this.fireEmoteFirework,
      },
      {
        id: 'start-commercial', definitions: { durationOfCommercial: [30, 60, 90, 120, 150, 180] }, fire: this.fireStartCommercial,
      },
      {
        id: 'bot-will-join-channel', definitions: {}, fire: this.fireBotWillJoinChannel,
      },
      {
        id: 'bot-will-leave-channel', definitions: {}, fire: this.fireBotWillLeaveChannel,
      },
      {
        id: 'create-a-clip', definitions: { announce: false, hasDelay: true, replay: false }, fire: this.fireCreateAClip,
      },
      {
        id: 'increment-custom-variable', definitions: { customVariable: '', numberToIncrement: 1 }, fire: this.fireIncrementCustomVariable,
      },
      {
        id: 'set-custom-variable', definitions: { customVariable: '', value: '' }, fire: this.fireSetCustomVariable,
      },
      {
        id: 'decrement-custom-variable', definitions: { customVariable: '', numberToDecrement: 1 }, fire: this.fireDecrementCustomVariable,
      },
    ];

    this.addMenu({
      category: 'manage', name: 'events', id: 'manage/events', this: null, scopeParent: this.scope(),
    });
    this.fadeOut();

    // emitter .on listeners
    for (const event of [
      'prediction-started',
      'prediction-locked',
      'prediction-ended',
      'poll-started',
      'poll-ended',
      'hypetrain-started',
      'hypetrain-ended',
      'hypetrain-level-reached',
      'action',
      'commercial',
      'game-changed',
      'follow',
      'cheer',
      'user-joined-channel',
      'user-parted-channel',
      'subcommunitygift',
      'reward-redeemed',
      'timeout',
      'ban',
      'raid',
      'stream-started',
      'stream-stopped',
      'subscription',
      'resub',
      'clearchat',
      'command-send-x-times',
      'chatter-first-message',
      'keyword-send-x-times',
      'every-x-minutes-of-stream',
      'stream-is-running-x-minutes',
      'subgift',
      'number-of-viewers-is-at-least-x',
      'tip',
      'obs-scene-changed',
      'obs-input-mute-state-changed',
      Types.onChannelShoutoutCreate,
      Types.onChannelShoutoutReceive,
      Types.onChannelAdBreakBegin,
    ] as const) {
      eventEmitter.on(event, (opts?: Attributes) => {
        if (typeof opts === 'undefined') {
          opts = {};
        }
        if (event === Types.onChannelAdBreakBegin) {
          events.fire('commercial', { ...opts });
        } else if (event === Types.onChannelShoutoutReceive) {
          events.fire('shoutout-received', { ...opts });
        } else if (event === Types.onChannelShoutoutCreate) {
          events.fire('shoutout-created', { ...opts });
        } else {
          events.fire(event as any, { ...opts });
        }
      });
    }
  }

  @onStreamEnd()
  resetExcludedUsers() {
    excludedUsers.clear();
  }

  @Get('/user/:userId')
  async getUserEvents(req: any) {
    const userId = req.params.userId;
    const eventsByUserId = await AppDataSource.getRepository(EventListEntity).findBy({ userId: userId });
    // we also need subgifts by giver
    const eventsByRecipientId
        = (await AppDataSource.getRepository(EventListEntity).findBy({ event: 'subgift' }))
          .filter(o => JSON.parse(o.values_json).fromId === userId);
    const evs =  orderBy([ ...eventsByRecipientId, ...eventsByUserId ], 'timestamp', 'desc');
    // we need to change userId => username and fromId => fromId username for eventlist compatibility
    const mapping = new Map() as Map<string, string>;
    for (const event of evs) {
      const values = JSON.parse(event.values_json);
      if (values.fromId && values.fromId != '0') {
        if (!mapping.has(values.fromId)) {
          mapping.set(values.fromId, await getNameById(values.fromId));
        }
      }
      if (!mapping.has(event.userId)) {
        mapping.set(event.userId, await getNameById(event.userId));
      }
    }
    return evs.map(event => {
      const values = JSON.parse(event.values_json);
      if (values.fromId && values.fromId != '0') {
        values.fromId = mapping.get(values.fromId);
      }
      return {
        ...event,
        username:    mapping.get(event.userId),
        values_json: JSON.stringify(values),
      };
    });
  }

  public async fire(eventId: string, attributes: Attributes): Promise<void> {
    attributes = cloneDeep(attributes) || {};
    debug('events', JSON.stringify({ eventId, attributes }));

    if (!attributes.isAnonymous) {
      if (attributes.userName !== null && typeof attributes.userName !== 'undefined' && (attributes.userId || !attributes.userId && !excludedUsers.has(attributes.userName))) {
        excludedUsers.delete(attributes.userName); // remove from excluded users if passed first if

        await changelog.flush();
        const user = attributes.userId
          ? await AppDataSource.getRepository(User).findOneBy({ userId: attributes.userId })
          : await AppDataSource.getRepository(User).findOneBy({ userName: attributes.userName });

        if (!user) {
          try {
            const userId = attributes.userId ? attributes.userId : await getIdFromTwitch(attributes.userName);
            changelog.update(userId, { userName: attributes.userName });
            return this.fire(eventId, attributes);
          } catch (e: any) {
            excludedUsers.add(attributes.userName);
            warning(`User ${attributes.userName} triggered event ${eventId} was not found on Twitch.`);
            warning(`User ${attributes.userName} will be excluded from events, until stream restarts or user writes in chat and his data will be saved.`);
            warning(e);
            return;
          }
        }

        attributes.eventId = eventId;

        // add is object
        attributes.is = {
          moderator:   isModerator(user),
          subscriber:  isSubscriber(user),
          vip:         isVIP(user),
          broadcaster: isBroadcaster(attributes.userName),
          bot:         isBot(attributes.userName),
          owner:       isOwner(attributes.userName),
        };
      }
    }
    if (!isNil(get(attributes, 'recipient', null))) {
      await changelog.flush();
      const user = await AppDataSource.getRepository(User).findOneBy({ userName: attributes.recipient });
      if (!user) {
        const userId = await getIdFromTwitch(attributes.recipient);
        changelog.update(userId, { userName: attributes.recipient });
        this.fire(eventId, attributes);
        return;
      }

      // add is object
      attributes.recipientis = {
        moderator:   isModerator(user),
        subscriber:  isSubscriber(user),
        vip:         isVIP(user),
        broadcaster: isBroadcaster(attributes.recipient),
        bot:         isBot(attributes.recipient),
        owner:       isOwner(attributes.recipient),
      };
    }
    if (get(attributes, 'reset', false)) {
      this.reset(eventId);
      return;
    }

    const eventsFromRepository = await Event.findBy(isUUID(eventId)
      ? { id: eventId, isEnabled: true }
      : { event: { name: eventId }, isEnabled: true },
    );

    for (const event of eventsFromRepository) {
      const [shouldRunByFilter, shouldRunByDefinition] = await Promise.all([
        this.checkFilter(event, cloneDeep(attributes)),
        this.checkDefinition(clone(event), cloneDeep(attributes)),
      ]);
      if ((!shouldRunByFilter || !shouldRunByDefinition) && !attributes.isTriggeredByCommand) {
        continue;
      }
      info(`Event ${eventId} with attributes ${JSON.stringify(attributes)} is triggered and running of operations.`);
      for (const operation of event.operations) {
        const isOperationSupported = typeof this.supportedOperationsList.find((o) => o.id === operation.name) !== 'undefined';
        if (isOperationSupported) {
          const foundOp = this.supportedOperationsList.find((o) =>  o.id === operation.name);
          if (foundOp) {
            if (attributes.isTriggeredByCommand && operation.name === 'run-command' && String(operation.definitions.commandToRun).startsWith(attributes.isTriggeredByCommand)) {
              warning(`Cannot trigger operation run-command ${operation.definitions.command}, because it would cause infinite loop.`);
            } else {
              foundOp.fire(operation.definitions, cloneDeep({ ...attributes, eventId: event.id }));
            }
          }
        }
      }
    }
  }

  // set triggered attribute to empty object
  public async reset(eventId: string) {
    for (const event of await Event.findBy({ event: { name: eventId } })) {
      event.event.triggered = {};
      await event.save();
    }
  }

  public async fireCreateAClip(operation: Operations['definitions']) {
    const cid = await createClip({ createAfterDelay: !!operation.hasDelay });
    if (cid) { // OK
      if (Boolean(operation.announce) === true) {
        announce(prepare('api.clips.created', { link: `https://clips.twitch.tv/${cid}` }), 'general');
      }

      if (operation.replay) {
        (await import('~/overlays/clips.js')).default.showClip(cid);
      }
      info('Clip was created successfully');
      return cid;
    } else { // NG
      warning('Clip was not created successfully');
      return null;
    }
  }

  public async fireBotWillJoinChannel() {
    tmiEmitter.emit('join', 'bot');
  }

  public async fireBotWillLeaveChannel() {

    tmiEmitter.emit('part', 'bot');
    // force all users offline
    await changelog.flush();
    await AppDataSource.getRepository(User).update({}, { isOnline: false });
  }

  public async fireStartCommercial(operation: Operations['definitions']) {
    try {
      const cid = variables.get('services.twitch.broadcasterId') as string;
      const broadcasterCurrentScopes = variables.get('services.twitch.broadcasterCurrentScopes') as string[];
      const duration = operation.durationOfCommercial
        ? Number(operation.durationOfCommercial)
        : 30;
      // check if duration is correct (30, 60, 90, 120, 150, 180)
      if ([30, 60, 90, 120, 150, 180].includes(duration)) {
        if (!broadcasterCurrentScopes.includes('channel:edit:commercial')) {
          warning('Missing Broadcaster oAuth scope channel:edit:commercial to start commercial');
          return;
        }
        if (!broadcasterCurrentScopes.includes('channel:edit:commercial')) {
          warning('Missing Broadcaster oAuth scope channel:edit:commercial to start commercial');
          return;
        }
        await twitch.apiClient?.asIntent(['broadcaster'], ctx => ctx.channels.startChannelCommercial(cid, duration as 30 | 60 | 90 | 120 | 150 | 180));
      } else {
        throw new Error('Incorrect duration set');
      }
    } catch (e) {
      if (e instanceof Error) {
        error(e.stack ?? e.message);
      }
    }
  }

  public async fireEmoteExplosion(operation: Operations['definitions']) {
    emitter.emit('services::twitch::emotes', 'explode', String(operation.emotesToExplode).split(' '));
  }

  public async fireEmoteFirework(operation: Operations['definitions']) {
    emitter.emit('services::twitch::emotes', 'firework', String(operation.emotesToFirework).split(' '));
  }

  public async fireSendChatMessageOrWhisper(operation: Operations['definitions'], attributes: Attributes, whisper: boolean): Promise<void> {
    const userName = isNil(attributes.userName) ? getOwner() : attributes.userName;
    let userId = attributes.userId;

    let userObj;
    if (userId) {
      userObj = await changelog.get(userId);
    } else {
      await changelog.flush();
      userObj = await AppDataSource.getRepository(User).findOneBy({ userName });
    }
    await changelog.flush();
    if (!userObj && !attributes.test) {
      userId = await getIdFromTwitch(userName);
      changelog.update(userId, { userName });
      return this.fireSendChatMessageOrWhisper(operation, {
        ...attributes, userId, userName,
      }, whisper);
    } else if (attributes.test) {
      userId = attributes.userId;
    } else if (!userObj) {
      return;
    }

    const message = attributesReplace(attributes, String(operation.messageToSend));
    parserReply(message, {
      id:      '',
      sender:  getUserSender(userId ?? '0', userName),
      discord: undefined,
    });
  }

  public async fireSendWhisper(operation: Operations['definitions'], attributes: Attributes) {
    events.fireSendChatMessageOrWhisper(operation, attributes, true);
  }

  public async fireSendChatMessage(operation: Operations['definitions'], attributes: Attributes) {
    events.fireSendChatMessageOrWhisper(operation, attributes, false);
  }

  public async fireSetCustomVariable(operation: Operations['definitions'], attributes: Attributes) {
    const customVariableName = operation.customVariable;
    const value = attributesReplace(attributes, String(operation.value));
    await setValueOf(String(customVariableName), value, {});

    const regexp = new RegExp(`\\$_${customVariableName}`, 'ig');
    const title = rawStatus.value;
    if (title.match(regexp)) {
      updateChannelInfo({});
    }
  }
  public async fireIncrementCustomVariable(operation: Operations['definitions']) {
    const customVariableName = String(operation.customVariable).replace('$_', '');
    const numberToIncrement = Number(operation.numberToIncrement);

    // check if value is number
    let currentValue: string | number = await getValueOf('$_' + customVariableName);
    if (!isFinite(parseInt(currentValue, 10))) {
      currentValue = String(numberToIncrement);
    } else {
      currentValue = String(parseInt(currentValue, 10) + numberToIncrement);
    }
    await setValueOf(String('$_' + customVariableName), currentValue, {});

    const regexp = new RegExp(`\\$_${customVariableName}`, 'ig');
    const title = rawStatus.value;
    if (title.match(regexp)) {
      updateChannelInfo({});
    }
  }

  public async fireDecrementCustomVariable(operation: Operations['definitions']) {
    const customVariableName = String(operation.customVariable).replace('$_', '');
    const numberToDecrement = Number(operation.numberToDecrement);

    // check if value is number
    let currentValue = await getValueOf('$_' + customVariableName);
    if (!isFinite(parseInt(currentValue, 10))) {
      currentValue = String(numberToDecrement * -1);
    } else {
      currentValue = String(parseInt(currentValue, 10) - numberToDecrement);
    }
    await setValueOf(String('$_' + customVariableName), currentValue, {});

    const regexp = new RegExp(`\\$_${customVariableName}`, 'ig');
    const title = rawStatus.value;
    if (title.match(regexp)) {
      updateChannelInfo({});
    }
  }

  public async everyXMinutesOfStream(event: Event) {
    if (event.event.name !== 'every-x-minutes-of-stream') {
      return false;
    }

    if (get(event.event, 'triggered.runEveryXMinutes', 0) === 0 || typeof get(event.event, 'triggered.runEveryXMinutes', 0) !== 'number') {
      // set to Date.now() because 0 will trigger event immediatelly after stream start
      event.event.triggered.runEveryXMinutes = Date.now();
      await event.save();
    }

    const runEveryXMinutesTriggered = event.event.triggered.runEveryXMinutes!;
    const shouldTrigger = Date.now() - new Date(runEveryXMinutesTriggered).getTime() >= Number(event.event.definitions.runEveryXMinutes) * 60 * 1000;
    if (shouldTrigger) {
      event.event.triggered.runEveryXMinutes = Date.now();
      await event.save();
    }
    return shouldTrigger;
  }

  public async isCorrectReward(event: Event, attributes: Attributes) {
    if (event.event.name !== 'reward-redeemed') {
      return false;
    }
    const shouldTrigger = (attributes.rewardId === event.event.definitions.rewardId);
    return shouldTrigger;
  }

  public async checkRaid(event: Event, attributes: Attributes) {
    if (event.event.name !== 'raid') {
      return false;
    }
    event.event.definitions.viewersAtLeast = Number(event.event.definitions.viewersAtLeast); // force Integer
    const shouldTrigger = (attributes.hostViewers >= event.event.definitions.viewersAtLeast);
    return shouldTrigger;
  }

  public async checkStreamIsRunningXMinutes(event: Event) {
    if (event.event.name !== 'stream-is-running-x-minutes') {
      return false;
    }
    if (!isStreamOnline.value) {
      return false;
    }
    event.event.triggered.runAfterXMinutes = get(event, 'triggered.runAfterXMinutes', 0);
    const shouldTrigger = event.event.triggered.runAfterXMinutes === 0
                          && Number(dayjs.utc().unix()) - Number(dayjs.utc(streamStatusChangeSince.value).unix()) > Number(event.event.definitions.runAfterXMinutes) * 60;
    if (shouldTrigger) {
      event.event.triggered.runAfterXMinutes = Number(event.event.definitions.runAfterXMinutes);
      await Event.save(event);
    }
    return shouldTrigger;
  }

  public async checkNumberOfViewersIsAtLeast(event: Event) {
    if (event.event.name !== 'number-of-viewers-is-at-least-x') {
      return false;
    }
    event.event.triggered.runInterval = get(event, 'triggered.runInterval', 0);

    event.event.definitions.runInterval = Number(event.event.definitions.runInterval); // force Integer
    event.event.definitions.viewersAtLeast = Number(event.event.definitions.viewersAtLeast); // force Integer

    const viewers = stats.value.currentViewers;

    const shouldTrigger = viewers >= event.event.definitions.viewersAtLeast
                        && ((event.event.definitions.runInterval > 0 && Date.now() - event.event.triggered.runInterval >= event.event.definitions.runInterval * 1000)
                        || (event.event.definitions.runInterval === 0 && event.event.triggered.runInterval === 0));
    if (shouldTrigger) {
      event.event.triggered.runInterval = Date.now();
      await Event.save(event);
    }
    return shouldTrigger;
  }

  public async checkCommandSendXTimes(event: Event, attributes: Attributes) {
    if (event.event.name !== 'command-send-x-times') {
      return false;
    }

    const regexp = new RegExp(`^${event.event.definitions.commandToWatch}\\s`, 'i');

    let shouldTrigger = false;
    attributes.message += ' ';
    if (attributes.message.match(regexp)) {
      event.event.triggered.runEveryXCommands = get(event, 'triggered.runEveryXCommands', 0);
      event.event.triggered.runInterval = get(event, 'triggered.runInterval', 0);

      event.event.definitions.runInterval = Number(event.event.definitions.runInterval); // force Integer
      event.event.triggered.runInterval = Number(event.event.triggered.runInterval); // force Integer

      event.event.triggered.runEveryXCommands++;
      shouldTrigger
        = event.event.triggered.runEveryXCommands >= Number(event.event.definitions.runEveryXCommands)
        && ((event.event.definitions.runInterval > 0 && Date.now() - event.event.triggered.runInterval >= event.event.definitions.runInterval * 1000)
        || (event.event.definitions.runInterval === 0 && event.event.triggered.runInterval === 0));
      if (shouldTrigger) {
        event.event.triggered.runInterval = Date.now();
        event.event.triggered.runEveryXCommands = 0;
      }
      await Event.save(event);
    }
    return shouldTrigger;
  }

  public async checkKeywordSendXTimes(event: Event, attributes: Attributes) {
    if (event.event.name !== 'keyword-send-x-times') {
      return false;
    }
    const regexp = new RegExp(`${event.event.definitions.keywordToWatch}`, 'gi');

    let shouldTrigger = false;
    attributes.message += ' ';
    const match = attributes.message.match(regexp);
    if (match) {
      event.event.triggered.runEveryXKeywords = get(event, 'triggered.runEveryXKeywords', 0);
      event.event.triggered.runInterval = get(event, 'triggered.runInterval', 0);

      event.event.definitions.runInterval = Number(event.event.definitions.runInterval); // force Integer
      event.event.triggered.runInterval = Number(event.event.triggered.runInterval); // force Integer

      if (event.event.definitions.resetCountEachMessage) {
        event.event.triggered.runEveryXKeywords = 0;
      }

      // add count from match
      event.event.triggered.runEveryXKeywords = Number(event.event.triggered.runEveryXKeywords) + Number(match.length);

      shouldTrigger
        = event.event.triggered.runEveryXKeywords >= Number(event.event.definitions.runEveryXKeywords)
        && ((event.event.definitions.runInterval > 0 && Date.now() - event.event.triggered.runInterval >= event.event.definitions.runInterval * 1000)
        || (event.event.definitions.runInterval === 0 && event.event.triggered.runInterval === 0));
      if (shouldTrigger) {
        event.event.triggered.runInterval = Date.now();
        event.event.triggered.runEveryXKeywords = 0;
      }
      await Event.save(event);
    }
    return shouldTrigger;
  }

  public async checkDefinition(event: Event, attributes: Attributes) {
    const foundEvent = this.supportedEventsList.find((o) => o.id === event.event.name);
    if (!foundEvent || !foundEvent.check) {
      return true;
    }
    return foundEvent.check(event, attributes);
  }

  public async checkFilter(event: Event, attributes: Attributes) {
    if (event.filter.trim().length === 0) {
      return true;
    }

    const customVariables = await getAll();
    const toEval = `(function () { return ${event.filter} })`;
    const sandbox = {
      $username: get(attributes, 'username', null),
      $source:   get(attributes, 'source', null),
      $is:       {
        moderator:   get(attributes, 'is.moderator', false),
        subscriber:  get(attributes, 'is.subscriber', false),
        vip:         get(attributes, 'is.vip', false),
        broadcaster: get(attributes, 'is.broadcaster', false),
        bot:         get(attributes, 'is.bot', false),
        owner:       get(attributes, 'is.owner', false),
      },
      $months:                       get(attributes, 'months', null),
      $monthsName:                   get(attributes, 'monthsName', null),
      $message:                      get(attributes, 'message', null),
      $command:                      get(attributes, 'command', null),
      $count:                        get(attributes, 'count', null),
      $bits:                         get(attributes, 'bits', null),
      $reason:                       get(attributes, 'reason', null),
      $target:                       get(attributes, 'target', null),
      $duration:                     get(attributes, 'duration', null),
      $hostViewers:                  get(attributes, 'hostViewers', null),
      // add global variables
      $viewers:                      stats.value.currentViewers,
      $game:                         stats.value.currentGame,
      $title:                        stats.value.currentTitle,
      $followers:                    stats.value.currentFollowers,
      $subscribers:                  stats.value.currentSubscribers,
      $isBotSubscriber:              isBotSubscriber(),
      $isStreamOnline:               isStreamOnline.value,
      // sub/resub
      $method:                       get(attributes, 'method', null),
      $tier:                         get(attributes, 'tier', null),
      $subStreakShareEnabled:        get(attributes, 'subStreakShareEnabled', null),
      $subStreak:                    get(attributes, 'subStreak', false),
      $subCumulativeMonths:          get(attributes, 'subCumulativeMonths', false),
      // hypetrain
      $level:                        get(attributes, 'level', null),
      $total:                        get(attributes, 'total', null),
      $goal:                         get(attributes, 'goal', null),
      $topContributionsBitsUserId:   get(attributes, 'topContributionsBitsUserId', null),
      $topContributionsBitsUsername: get(attributes, 'topContributionsBitsUsername', null),
      $topContributionsBitsTotal:    get(attributes, 'topContributionsBitsTotal', null),
      $topContributionsSubsUserId:   get(attributes, 'topContributionsSubsUserId', null),
      $topContributionsSubsUsername: get(attributes, 'topContributionsSubsUsername', null),
      $topContributionsSubsTotal:    get(attributes, 'topContributionsSubsTotal', null),
      $lastContributionType:         get(attributes, 'lastContributionType', null),
      $lastContributionUserId:       get(attributes, 'lastContributionUserId', null),
      $lastContributionUsername:     get(attributes, 'lastContributionUsername', null),
      $lastContributionTotal:        get(attributes, 'lastContributionTotal', null),
      // game-changed
      $oldGame:                      get(attributes, 'oldGame', null),
      // reward
      $userInput:                    get(attributes, 'userInput', null),
      ...customVariables,
    };
    let result = false;
    try {
      const vm = new VM({ sandbox });
      result = vm.run(toEval)();
    } catch (e: any) {
      // do nothing
    }
    return !!result; // force boolean
  }

  @Get('/rewards', { scope: 'public' })
  public async getRedeemedRewards() {
    const rewards = await getCustomRewards() ?? [];
    return [...rewards.map(o => ({ name: o.title, id: o.id }))];
  }
  @Post('/', { action: 'listSupportedOperations' })
  public async listSupportedOperations() {
    return this.supportedOperationsList;
  }
  @Post('/', { action: 'listSupportedEvents' })
  public async listSupportedEvents() {
    return this.supportedEventsList;
  }
  @Post('/', {
    action: 'testEvent',
  })
  public async testEvent(req: Request) {
    const { id, randomized, values, variables: variablesArg } = req.body;
    const attributes: Record<string, any> = {
      test:     true,
      userId:   '0',
      currency: sample(['CZK', 'USD', 'EUR']),
      ...variablesArg.map((variableMap: any, idx: any) => {
        if (['username', 'recipient', 'target', 'topContributionsBitsUsername', 'topContributionsSubsUsername', 'lastContributionUsername'].includes(variableMap)) {
          return { [variableMap]: randomized.includes(variableMap) ? generateUsername() : values[idx] };
        } else if (['userInput', 'message', 'reason'].includes(variableMap)) {
          return { [variableMap]: randomized.includes(variableMap) ? sample(['', 'Lorem Ipsum Dolor Sit Amet']) : values[idx] };
        } else if (['source'].includes(variableMap)) {
          return { [variableMap]: randomized.includes(variableMap) ? sample(['Twitch', 'Discord']) : values[idx] };
        } else if (['tier'].includes(variableMap)) {
          return { [variableMap]: randomized.includes(variableMap) ? random(0, 3, false) : (values[idx] === 'Prime' ? 0 : Number(values[idx]))  };
        } else if (['hostViewers', 'lastContributionTotal', 'topContributionsSubsTotal', 'topContributionsBitsTotal', 'duration', 'viewers', 'bits', 'subCumulativeMonths', 'count', 'subStreak', 'amount', 'amountInBotCurrency'].includes(variableMap)) {
          return { [variableMap]: randomized.includes(variableMap) ? random(10, 10000000000, false) : values[idx]  };
        } else if (['game', 'oldGame'].includes(variableMap)) {
          return {
            [variableMap]: randomized.includes(variableMap)
              ? sample(['Dota 2', 'Escape From Tarkov', 'Star Citizen', 'Elite: Dangerous'])
              : values[idx],
          };
        } else if (['command'].includes(variableMap)) {
          return { [variableMap]: randomized.includes(variableMap) ? sample(['!me', '!top', '!points']) : values[idx]  };
        } else if (['subStreakShareEnabled'].includes(variableMap) || variableMap.startsWith('is.') || variableMap.startsWith('recipientis.')) {
          return { [variableMap]: randomized.includes(variableMap) ? random(0, 1, false) === 0 : values[idx]  };
        } else if (['level'].includes(variableMap)) {
          return { [variableMap]: randomized.includes(variableMap) ? random(1, 5, false)  : values[idx]  };
        } else if (['topContributionsSubsUserId', 'topContributionsBitsUserId', 'lastContributionUserId'].includes(variableMap)) {
          return { [variableMap]: randomized.includes(variableMap) ? String(random(90000, 900000, false)) : values[idx]  };
        } else if (['lastContributionType'].includes(variableMap)) {
          return { [variableMap]: randomized.includes(variableMap) ? sample(['BITS', 'SUBS']) : values[idx]  };
        }
      }).reduce((prev: any, cur: any) => {
        return { ...prev, ...cur };
      }, {}),
    };

    if (attributes.subStreak !== undefined) {
      attributes.subStreakName = getLocalizedName(attributes.subStreak, 'core.months');
    }

    if (attributes.subCumulativeMonths !== undefined) {
      attributes.subCumulativeMonthsName = getLocalizedName(attributes.subCumulativeMonths, 'core.months');
    }

    if (attributes.subCumulativeMonths !== undefined) {
      attributes.subCumulativeMonthsName = getLocalizedName(attributes.subCumulativeMonths, 'core.months');
    }

    if (attributes.amountInBotCurrency !== undefined) {
      attributes.currencyInBot = mainCurrency.value;
    }

    if (attributes.amountInBotCurrency !== undefined) {
      attributes.currencyInBot = mainCurrency.value;
    }

    if (attributes.amount !== undefined) {
      attributes.amount = Number(attributes.amount).toFixed(2);
    }

    const event = await Event.findOne({
      where: { id },
    });
    if (event) {
      for (const operation of event.operations) {
        const foundOp = this.supportedOperationsList.find((o) => o.id === operation.name);
        if (foundOp) {
          foundOp.fire(operation.definitions, attributes);
        }
      }
    }
    return null;
  }

  @Get('/')
  getAll() {
    return Event.find();
  }
  @Get('/:id')
  async getOne(req: Request) {
    const id = req.params.id;
    const event = await Event.findOne({
      where: { id },
    });

    return event ?? Event.create({ id });
  }
  @Delete('/:id')
  async removeOne(req: any) {
    const al = await Event.findOneBy({ id: req.params.id });
    if (al) {
      await al.remove();
    }
  }

  @Post('/')
  async create(req: Request) {
    const event = Event.create(req.body);
    return event.save();
  }

  protected async fadeOut() {
    if (!isDbConnected) {
      setTimeout(() => this.fadeOut, 10);
      return;
    }

    try {
      for (const event of await Event.find({ where: [
        { event: { name: 'command-send-x-times' } },
        { event: { name: 'keyword-send-x-times' } },
      ] })) {
        // narrow typings
        if (event.event.name !== 'command-send-x-times' && event.event.name !== 'keyword-send-x-times') {
          continue;
        }

        if (isNil(get(event, 'triggered.fadeOutInterval', null))) {
          event.event.triggered.fadeOutInterval = Date.now();
          await Event.save(event);
        } else {
          if (Date.now() - event.event.triggered.fadeOutInterval! >= Number(event.event.definitions.fadeOutInterval) * 1000) {
            // fade out commands
            if (event.event.name === 'command-send-x-times') {
              if (!isNil(get(event, 'triggered.runEveryXCommands', null))) {
                if (event.event.triggered.runEveryXCommands! <= 0) {
                  continue;
                }

                event.event.triggered.fadeOutInterval = Date.now();
                event.event.triggered.runEveryXCommands = event.event.triggered.runEveryXCommands! - Number(event.event.definitions.fadeOutXCommands);
                await Event.save(event);
              }
            } else if (event.event.name === 'keyword-send-x-times') {
              if (!isNil(get(event, 'triggered.runEveryXKeywords', null))) {
                if (event.event.triggered.runEveryXKeywords! <= 0) {
                  continue;
                }

                event.event.triggered.fadeOutInterval = Date.now();
                event.event.triggered.runEveryXKeywords = event.event.triggered.runEveryXKeywords! - Number(event.event.definitions.fadeOutXKeywords);
                await Event.save(event);
              }
            }
          }
        }
      }
    } catch (e: any) {
      error(e.stack);
    } finally {
      clearTimeout(this.timeouts.fadeOut);
      this.timeouts.fadeOut = setTimeout(() => this.fadeOut(), 1000);
    }
  }
}

export default new Events();
