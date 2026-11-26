import { Context, Effect, Layer } from 'effect';
import { RuntimeContext } from '#src/context';
import { FitDecoder } from '#src/repositories/fit-decoder.repository';
import type { PowerBests } from '#src/repositories/fit-decoder.repository';
import { fitWorkers } from '#src/repositories/fit.repository';
import { Metric, metrics } from '#src/repositories/metrics.repository';

function decodeFit(bytes: Uint8Array) {
  return metrics.time(Metric.FitProcessing, () => new FitDecoder().decode(bytes));
}

function activityChart(bytes: Uint8Array) {
  return metrics.time(Metric.FitProcessing, () => new FitDecoder().chart(bytes));
}

function chart(bytes: Uint8Array) {
  return fitWorkers.chart(bytes);
}

function powerBests(bytes: Uint8Array) {
  return fitWorkers.powerBests(bytes);
}

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const repositories = context.accounts.repositories;

  const savePowerCurve = Effect.fn('FitService.savePowerCurve')(function* (playerId: number, bytes: Uint8Array) {
    yield* insertPowerBests(
      playerId,
      metrics.time(Metric.FitProcessing, () => new FitDecoder().powerBests(bytes)),
    );
  });

  const insertPowerBests = Effect.fn('FitService.insertPowerBests')(function* (
    playerId: number,
    curve: PowerBests,
    activity: number | null = null,
  ) {
    const weight = repositories.profileRepository.get(playerId).weightInGrams / 1000;

    if (weight <= 0) {
      return;
    }

    for (const { time, power } of curve.bests) {
      repositories.fitnessRepository.insertPowerCurve(
        playerId,
        String(time),
        power,
        Number((power / weight).toFixed(2)),
        curve.timestamp,
        activity,
      );
    }
  });

  return { savePowerCurve, insertPowerBests };
});

export class FitService extends Context.Service<FitService, Effect.Success<typeof make>>()('zluggish/FitService') {
  static readonly layer = Layer.effect(FitService, make);

  static readonly decodeFit = decodeFit;

  static readonly activityChart = activityChart;

  static readonly chart = chart;

  static readonly powerBests = powerBests;
}
