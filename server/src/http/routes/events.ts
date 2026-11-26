import { EventCatalogService } from '#src/services/event-catalog.service';
import { effectRoutes } from '#src/http/effect';
import { EventsService } from '#src/services/events.service';
import { notificationUpdateSchema } from '#src/dtos/events.dto';
import { decodeMeetupInput } from '#src/dtos/meetup.dto';
import type { Meetup } from '#src/dtos/meetup.dto';
import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import {
  EventsSchema,
  LateJoinInformationSchema,
  PrivateEventFeedListProtoSchema,
  PrivateEventFeedProtoSchema,
  PrivateEventProtoSchema,
} from '#src/protocol/generated/events_pb';
import { forward, road } from '#src/world/state';
import { create, toBinary } from '@bufbuild/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { Effect, Schema } from 'effect';
import { NumberFromInput } from '#src/schema';

function social(event: Meetup, id: number) {
  return {
    ...event,
    inviteStatus: event.eventInvites.find((invite) => invite.invitedProfile.id === id)?.status ?? 'PENDING',
    eventInvites: event.eventInvites.map((invite) => ({
      ...invite,
      invitedProfile: {
        ...invite.invitedProfile,
        socialFacts: {
          followerStatusOfLoggedInPlayer: invite.invitedProfile.id === id ? 'SELF' : 'IS_FOLLOWING',
          isFavoriteOfLoggedInPlayer: invite.invitedProfile.id !== id,
        },
      },
    })),
  };
}

function visible(event: Meetup, id: number) {
  return event.organizerProfileId === id || event.invitedProfileIds.includes(id);
}

const limit = (value: string | undefined) =>
  Schema.decodeUnknownSync(
    NumberFromInput.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1000)),
  )(value ?? 100);

export function eventRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const appRoutes = effectRoutes(app, runtime);

  appRoutes.get('/api/event-feed', (c) =>
    Effect.gen(function* () {
      const eventsService = yield* EventsService;
      const events = yield* eventsService.eventsAt(runtime.assets, limit(c.req.query('limit')), c.req.query('sport'));
      const data = yield* Effect.forEach(events, (event) =>
        eventsService.eventJSON(event).pipe(Effect.map((event) => ({ event }))),
      );

      return c.json({
        data,
        cursor: null,
      });
    }),
  );
  appRoutes.post('/api/events/search', (c) =>
    Effect.gen(function* () {
      const eventsService = yield* EventsService;

      const events = yield* eventsService.eventsAt(runtime.assets, limit(c.req.query('limit')));

      return c.req.header('Accept')?.includes('application/json')
        ? c.json(events.map((event) => EventCatalogService.eventJSON(event)))
        : c.body(toBinary(EventsSchema, create(EventsSchema, { events })));
    }),
  );
  appRoutes.get('/api/events/:id', (c) =>
    Effect.gen(function* () {
      const eventsService = yield* EventsService;

      const event = (yield* eventsService.eventsAt(runtime.assets)).find(
        (item) => item.id === BigInt(c.req.param('id')),
      );

      return event ? c.json(yield* eventsService.eventJSON(event)) : c.body(null, 200);
    }),
  );
  appRoutes.on(['POST', 'DELETE'], ['/api/events/subgroups/signup/:id', '/api/events/signup/:id'], (c) =>
    Effect.gen(function* () {
      const eventsService = yield* EventsService;

      const user = authenticated(c);
      const joining = c.req.method === 'POST';
      const id = BigInt(c.req.param('id'));

      yield* eventsService.announceSignup(user.player_id, id, joining);

      return c.json({ signedUp: joining });
    }),
  );
  appRoutes.get('/api/private_event/feed', (c) =>
    Effect.gen(function* () {
      const eventsService = yield* EventsService;

      const user = authenticated(c);
      let start = Number(c.req.query('start_date') ?? 0);

      if (start === -1_800_000) {
        start += Date.now();
      }

      const events = (yield* eventsService.all()).filter(
        (event) =>
          visible(event, user.player_id) &&
          (Date.parse(event.eventStart) > start ||
            (c.req.query('organizer_only_past_events') === 'true' && event.organizerProfileId === user.player_id)),
      );

      if (c.req.header('Accept')?.includes('application/json')) {
        return c.json(events.map((event) => social(event, user.player_id)));
      }

      return c.body(
        toBinary(
          PrivateEventFeedListProtoSchema,
          create(PrivateEventFeedListProtoSchema, {
            pef: events.map((event) =>
              create(PrivateEventFeedProtoSchema, {
                eventId: BigInt(event.id),
                sport: event.sport === 'RUNNING' ? 1 : 0,
                eventSubgroupStart: BigInt(Date.parse(event.eventStart)),
                routeId: BigInt(event.routeId),
                durationInSeconds: event.durationInSeconds,
                distanceInMeters: event.distanceInMeters,
                answeredCount: 1n,
                invitedTotalCount: event.invitedTotalCount,
                acceptedFolloweeCount: event.acceptedFolloweeCount,
                acceptedTotalCount: event.acceptedTotalCount,
                organizerImageUrl: event.organizerImageUrl ?? '',
                organizerProfileId: BigInt(event.organizerProfileId),
                organizerFirstName: event.organizerFirstName,
                organizerLastName: event.organizerLastName,
                updateDate: BigInt(Date.parse(event.updateDate)),
                subgroupId: BigInt(event.eventSubgroupId),
                laps: event.laps,
                rubberbanding: event.rubberbanding,
              }),
            ),
          }),
        ),
      );
    }),
  );
  appRoutes.post('/api/private_event', (c) =>
    Effect.gen(function* () {
      const eventsService = yield* EventsService;

      const user = authenticated(c);
      const input = decodeMeetupInput(yield* Effect.promise(() => c.req.json()));
      const id = yield* eventsService.createMeetup(user, input);

      return c.json({ id }, 201);
    }),
  );
  appRoutes.on(['GET', 'PUT', 'DELETE'], '/api/private_event/:id{[0-9]+}', (c) =>
    Effect.gen(function* () {
      const eventsService = yield* EventsService;

      const user = authenticated(c);
      const event = yield* eventsService.read(c.req.param('id'));

      if (!visible(event, user.player_id)) {
        throw new HTTPException(403);
      }

      if (c.req.method === 'GET') {
        if (c.req.header('Accept')?.includes('application/json')) {
          return c.json(social(event, user.player_id));
        }

        return c.body(
          toBinary(
            PrivateEventProtoSchema,
            create(PrivateEventProtoSchema, {
              id: BigInt(event.id),
              sport: event.sport === 'RUNNING' ? 1 : 0,
              eventStart: BigInt(Date.parse(event.eventStart)),
              routeId: BigInt(event.routeId),
              startLocation: BigInt(event.startLocation),
              durationInSeconds: event.durationInSeconds,
              distanceInMeters: event.distanceInMeters,
              description: event.description,
              workoutHash: BigInt(event.workoutHash),
              organizerId: BigInt(event.organizerProfileId),
              showResults: event.showResults,
              laps: event.laps,
              rubberbanding: event.rubberbanding,
              eventInvites: event.eventInvites.map((invite) => ({
                profile: {
                  playerId: BigInt(invite.invitedProfile.id),
                  firstName: invite.invitedProfile.firstName,
                  lastName: invite.invitedProfile.lastName,
                  imageSrc: invite.invitedProfile.imageSrc ?? '',
                  enrolledZwiftAcademy: invite.invitedProfile.enrolledZwiftAcademy,
                  male: invite.invitedProfile.male,
                  playerType: 1,
                  eventCategory: invite.invitedProfile.male ? 1 : 0,
                },
                status: invite.status === 'ACCEPTED' ? 1 : invite.status === 'REJECTED' ? 2 : 0,
              })),
            }),
          ),
        );
      }

      if (event.organizerProfileId !== user.player_id) {
        throw new HTTPException(403);
      }

      if (c.req.method === 'DELETE') {
        yield* eventsService.deleteMeetup(event);

        return c.body(null, 200);
      }

      const update = decodeMeetupInput(yield* Effect.promise(() => c.req.json()));

      yield* eventsService.updateMeetup(event, update);

      return c.json({ id: event.id });
    }),
  );
  appRoutes.put('/api/private_event/:id{[0-9]+}/:decision{accept|reject}', (c) =>
    Effect.gen(function* () {
      const eventsService = yield* EventsService;

      const user = authenticated(c);
      const event = yield* eventsService.read(c.req.param('id'));

      yield* eventsService.respondToInvite(event, user.player_id, c.req.param('decision') === 'accept');

      return c.body(null, 204);
    }),
  );
  appRoutes.get('/api/notifications', (c) =>
    Effect.gen(function* () {
      const eventsService = yield* EventsService;

      const user = authenticated(c);

      return c.json(yield* eventsService.notifications(user.player_id));
    }),
  );
  appRoutes.put('/api/notifications/:id', (c) =>
    Effect.gen(function* () {
      const eventsService = yield* EventsService;

      const user = authenticated(c);
      const update = Schema.decodeUnknownSync(notificationUpdateSchema)(yield* Effect.promise(() => c.req.json()));
      yield* eventsService.markNotification(user.player_id, c.req.param('id'), update);

      return c.body(null, 204);
    }),
  );
  appRoutes.get('/relay/events/subgroups/:id{[0-9]+}/late-join', (c) =>
    Effect.gen(function* () {
      const eventsService = yield* EventsService;

      const user = authenticated(c);
      const event = yield* eventsService.read(c.req.param('id'));

      if (!visible(event, user.player_id)) {
        throw new HTTPException(403);
      }

      const leader = [...runtime.world.online].find(
        ([id, state]) => id !== BigInt(user.player_id) && state.groupId === BigInt(event.id),
      );

      if (!leader) {
        return c.body(null, 200);
      }

      return c.body(
        toBinary(
          LateJoinInformationSchema,
          create(LateJoinInformationSchema, {
            roadId: BigInt(road(leader[1])),
            roadTime: (leader[1].roadTime - 5000) / 1_000_000,
            isForward: forward(leader[1]),
            organizerId: leader[0],
            ljF5: 0,
            ljF6: 0,
            ljF7: 0,
          }),
        ),
      );
    }),
  );
}
