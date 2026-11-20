import type { PlanBlock, WorkoutPlan } from '#src/world/zwo';

/** The voice reads pl and en; numbers are spoken the way a coach says them. */
export type VoiceLanguage = 'pl' | 'en';

export function fmtDuration(seconds: number, language: VoiceLanguage) {
  const whole = Math.round(seconds);

  if (whole >= 60) {
    const minutes = Math.floor(whole / 60);
    const rest = whole % 60;

    if (language === 'en')
      {return rest === 0 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : `${minutes} minutes and ${rest} seconds`;}

    const minuteWord = minutes === 1 ? 'minuta' : minutes >= 2 && minutes <= 4 ? 'minuty' : 'minut';

    if (rest === 0) {return `${minutes} ${minuteWord}`;}

    const restWord = rest === 1 ? 'sekunda' : rest >= 2 && rest <= 4 ? 'sekundy' : 'sekund';

    return `${minutes} ${minuteWord} i ${rest} ${restWord}`;
  }

  if (language === 'en') {return `${whole} second${whole === 1 ? '' : 's'}`;}

  return `${whole} ${whole === 1 ? 'sekunda' : whole >= 2 && whole <= 4 ? 'sekundy' : 'sekund'}`;
}

const say = (value: number) => String(Math.round(value));

export function fmtPower(power: PlanBlock['power'], language: VoiceLanguage) {
  if (power === null) {return language === 'pl' ? 'dowolna moc' : 'free power';}

  const unit =
    power.format === 'ftp'
      ? language === 'pl'
        ? 'procent FTP'
        : 'percent of FTP'
      : language === 'pl'
        ? 'watów'
        : 'watts';

  if (power.low !== power.high)
    {return language === 'pl'
      ? `po ${say(power.low)} do ${say(power.high)} ${unit}`
      : `at ${say(power.low)} to ${say(power.high)} ${unit}`;}

  return language === 'pl' ? `po ${say(power.low)} ${unit}` : `at ${say(power.low)} ${unit}`;
}

/** One block read the way you would shout it from beside the trainer. */
/** A block of the plan: announced a few seconds ahead, or read when the game starts it (`now`). */
export function blockSpeech(
  block: PlanBlock,
  index: number,
  total: number,
  language: VoiceLanguage,
  when: 'ahead' | 'now' = 'ahead',
) {
  const parts: Array<string> = [];

  if (block.durationSeconds !== null) {parts.push(fmtDuration(block.durationSeconds, language));}
  else if (block.meters !== null) {parts.push(`${Math.round(block.meters)} ${language === 'pl' ? 'metrów' : 'meters'}`);}

  parts.push(fmtPower(block.power, language));

  if (block.cadence !== null)
    {parts.push(language === 'pl' ? `kadencja ${Math.round(block.cadence)}` : `cadence ${Math.round(block.cadence)}`);}

  const lead = when === 'now' ? ['Teraz', 'Now'] : ['Za chwilę', 'Up next'];

  const head =
    language === 'pl' ? `${lead[0]} blok ${index + 1} z ${total}` : `${lead[1]}, block ${index + 1} of ${total}`;

  const name = block.name ? (language === 'pl' ? `, ${block.name}` : `: ${block.name}`) : '';
  const body = language === 'pl' ? ` po ${parts.join(', ')}` : `, ${parts.join(', ')}`;

  return `${head}${name}${body}.`;
}

export function summarySpeech(plan: WorkoutPlan, language: VoiceLanguage) {
  const count = plan.blocks.length;
  const total = plan.totalSeconds > 0 ? fmtDuration(plan.totalSeconds, language) : null;

  if (language === 'pl') {
    const word = count === 1 ? 'blok' : count >= 2 && count <= 4 ? 'bloki' : 'bloków';

    return `Trening ${plan.name}: ${count} ${word}${total ? `, razem ${total}` : ''}. Jedziemy.`;
  }

  return `Workout ${plan.name}: ${count} block${count === 1 ? '' : 's'}${total ? `, ${total} all together` : ''}. Let's go.`;
}

export function countdownSpeech(seconds: number, next: PlanBlock | null, language: VoiceLanguage) {
  const base = language === 'pl' ? `${seconds} sekund do końca bloku.` : `${seconds} seconds left in this block.`;

  if (next === null) {return base;}

  const duration = fmtDuration(next.durationSeconds ?? 0, language);

  const power = next.power
    ? language === 'pl'
      ? `, ${fmtPower(next.power, language)}`
      : `, ${fmtPower(next.power, language)}`
    : '';

  return `${base} ${language === 'pl' ? 'Następnie' : 'Next up'} ${duration}${power}.`;
}

export function finishSpeech(language: VoiceLanguage) {
  return language === 'pl' ? 'Koniec treningu. Bardzo dobrze!' : 'Workout complete. Well done!';
}

export function startSpeech(language: VoiceLanguage) {
  return language === 'pl' ? 'Zaczynamy trening.' : 'Workout starting.';
}

export function targetSpeech(watts: number, language: VoiceLanguage) {
  return language === 'pl' ? `Cel mocy: ${Math.round(watts)} watów.` : `Power target: ${Math.round(watts)} watts.`;
}

const POLISH_MARKS = /[ąćęłńóśźż]/i;
const POLISH_WORDS = /\b(teraz|albo|dobrze|jedziemy|panowie|trzymaj|spokojnie|mocniej|jeszcze|siema|hej)\b/i;

/** Which language a chat bubble is written in, so the voice fits the words. */
export function chatLanguage(text: string): VoiceLanguage | undefined {
  if (POLISH_MARKS.test(text) || POLISH_WORDS.test(text)) {return 'pl';}

  if (/[a-z]{3}/i.test(text)) {return 'en';}

  return undefined;
}

/** Chat bubble of the game: the name leads without its team tags, then what they wrote. */
export function chatSpeech(from: string, text: string, language: VoiceLanguage) {
  const speaker = from.replaceAll(/\s*\(([^)]*)\)/g, '').trim();
  const said = text;

  return speaker ? `${speaker}${language === 'pl' ? ', mówi:' : ' says:'} ${said}` : said;
}
