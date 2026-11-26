import { ActivitySport, MeetupInviteStatus } from '#src/enum';
import { decodeOwned, IsoDateTime, Strict, withDefault } from '#src/schema';
import { Schema, Struct } from 'effect';
import type { Types } from 'effect';

const inputFields = {
  culling: Schema.Boolean.pipe(withDefault(false)),
  description: Schema.String.pipe(withDefault('')),
  distanceInMeters: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  durationInSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  eventStart: IsoDateTime,
  invitedProfileIds: Schema.Array(Schema.Int.check(Schema.isGreaterThan(0))).check(Schema.isMaxLength(100)),
  laps: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  routeId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  rubberbanding: Schema.Boolean,
  showResults: Schema.Boolean,
  sport: Schema.Enum(ActivitySport),
  workoutHash: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
};

export const inputSchema = Schema.Struct(inputFields);

const { culling, description, ...requiredInput } = inputFields;

/** Changes to a meetup: every field is optional, but `culling` and `description` keep their defaults. */
export const inputChanges = Strict({ culling, description, ...Struct.map(requiredInput, Schema.optional) });

const profileSchema = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.Int.check(Schema.isGreaterThan(0)),
    firstName: Schema.String,
    lastName: Schema.String,
    male: Schema.Boolean,
    imageSrc: Schema.NullOr(Schema.String),
    playerType: Schema.String,
    enrolledZwiftAcademy: Schema.Boolean,
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

const inviteSchema = Schema.Struct({ invitedProfile: profileSchema, status: Schema.Enum(MeetupInviteStatus) });

export const storedSchema = Schema.Struct({
  ...inputFields,
  id: Schema.Finite,
  eventSubgroupId: Schema.Finite,
  name: Schema.String,
  organizerProfileId: Schema.Finite,
  organizerId: Schema.Finite,
  organizerFirstName: Schema.String,
  organizerLastName: Schema.String,
  organizerImageUrl: Schema.NullOr(Schema.String),
  updateDate: Schema.String,
  invitedTotalCount: Schema.Finite,
  acceptedTotalCount: Schema.Finite,
  acceptedFolloweeCount: Schema.Finite,
  startLocation: Schema.Finite,
  allowsLateJoin: Schema.Boolean,
  eventInvites: Schema.Array(inviteSchema),
});

export type Meetup = Types.DeepMutable<typeof storedSchema.Type>;

export type MeetupInput = Types.DeepMutable<typeof inputSchema.Type>;

export const decodeMeetup = decodeOwned(storedSchema);

export const decodeMeetupInput = decodeOwned(inputSchema);
