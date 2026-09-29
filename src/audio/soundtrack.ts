import * as Tone from 'tone';

/**
 * TESTIMONY — soundtrack
 *
 * A bossa nova loop rendered as if through a 1995 sound card.
 *
 * The joke is NOT "bland music". Bland executed well is just bland, and it
 * stops being funny about ten seconds in. The joke is a lounge-jazz loop
 * played on cheap FM synthesis: a plastic electric piano, a rubbery bass, a
 * muted trumpet that sounds like a kazoo. It is genuinely pleasant to listen
 * to AND unmistakably fake — which matches a game that looks like a 1995
 * desktop utility.
 *
 * The signal chain does the heavy lifting:
 *   FM voices -> bitcrusher (sample-rate grit) -> bandpass (small speaker)
 *               -> reverb (an office, not a hall) -> out
 *
 * Diegetically this is a radio in the claims office. That licenses the lo-fi,
 * and it means cutting to silence is available as a tool when something
 * actually matters.
 *
 * THE ONE RULE THAT MUST SURVIVE: the music never acknowledges failure. It
 * keeps playing, cheerfully, over the rejection screen. Indifference is the
 * gag. Do not add a sad trombone.
 */

export type Layer = 'chords' | 'bass' | 'drums' | 'vibes';
export type Sfx = 'stamp' | 'correct' | 'invalid' | 'reveal';

const BPM = 104;

/**
 * Eight bars of ii-V-I in C, with a secondary dominant in the last bar to
 * yank it back to the top. Endlessly pleasant, going absolutely nowhere.
 */
const CHORDS: string[][] = [
  ['D3', 'F3', 'A3', 'C4'],   // Dm7
  ['G2', 'B3', 'D4', 'F4'],   // G7
  ['C3', 'E3', 'G3', 'B3'],   // Cmaj7
  ['C3', 'E3', 'G3', 'B3'],   // Cmaj7
  ['D3', 'F3', 'A3', 'C4'],   // Dm7
  ['G2', 'B3', 'D4', 'F4'],   // G7
  ['C3', 'E3', 'G3', 'B3'],   // Cmaj7
  ['A2', 'C#4', 'E4', 'G4'],  // A7 — turnaround
];

const ROOTS = ['D2', 'G1', 'C2', 'C2', 'D2', 'G1', 'C2', 'A1'];
const FIFTHS = ['A2', 'D2', 'G2', 'G2', 'A2', 'D2', 'G2', 'E2'];

/**
 * Bossa comping, in beats from the bar line. The syncopation on the "and of
 * two" is what stops this being a waltz-time nursery rhyme.
 */
const COMP_BEATS = [0, 1.5, 3];

/** Muted-trumpet stabs. Sparse — this layer is a garnish, not a melody. */
const TRUMPET = ['E4', 'G4', 'A4', 'G4', 'E4', 'D4', 'E4', 'C#4'];

export class Soundtrack {
  private started = false;
  private ready = false;

  private crusher!: Tone.BitCrusher;
  private speaker!: Tone.Filter;
  private highCut!: Tone.Filter;
  private room!: Tone.Reverb;
  private master!: Tone.Volume;

  private rhodes!: Tone.PolySynth<Tone.FMSynth>;
  private bass!: Tone.MonoSynth;
  private brush!: Tone.NoiseSynth;
  private rim!: Tone.MembraneSynth;
  private trumpet!: Tone.FMSynth;
  private vibes!: Tone.FMSynth;

  private gains: Record<Layer, Tone.Gain> = {} as Record<Layer, Tone.Gain>;
  private enabled: Record<Layer, boolean> = {
    chords: true,
    bass: true,
    drums: true,
    vibes: false,
  };

  private sequence?: Tone.Sequence<number>;

  /**
   * Build the graph. Cheap to call; makes no sound and starts no audio
   * context, so it is safe to run before any user gesture.
   */
  private build(): void {
    if (this.ready) return;

    this.master = new Tone.Volume(-9).toDestination();

    // An office, not a concert hall. Short and dull on purpose.
    this.room = new Tone.Reverb({ decay: 1.1, wet: 0.16 }).connect(this.master);

    // Small plastic speaker: nothing below 320Hz, nothing above 3.6kHz.
    this.highCut = new Tone.Filter({ frequency: 3600, type: 'lowpass', rolloff: -24 })
      .connect(this.room);
    this.speaker = new Tone.Filter({ frequency: 320, type: 'highpass', rolloff: -12 })
      .connect(this.highCut);

    // 8-bit sample-rate grit. This is the single most important effect in the
    // chain — without it the FM voices sound like a competent synth rather
    // than a sound card.
    this.crusher = new Tone.BitCrusher(8).connect(this.speaker);
    this.crusher.wet.value = 0.3;

    for (const layer of ['chords', 'bass', 'drums', 'vibes'] as Layer[]) {
      this.gains[layer] = new Tone.Gain(this.enabled[layer] ? 1 : 0).connect(this.crusher);
    }

    // Plastic FM electric piano. harmonicity 2 + fast decay = DX7-by-way-of-
    // a-Yamaha-keyboard-in-a-hotel-lobby.
    this.rhodes = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 2,
      modulationIndex: 6,
      oscillator: { type: 'sine' },
      modulation: { type: 'square' },
      envelope: { attack: 0.004, decay: 0.9, sustain: 0.05, release: 0.9 },
      modulationEnvelope: { attack: 0.002, decay: 0.35, sustain: 0, release: 0.2 },
      volume: -13,
    }).connect(this.gains.chords);

    this.bass = new Tone.MonoSynth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.5 },
      filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.3, baseFrequency: 120, octaves: 2 },
      volume: -11,
    }).connect(this.gains.bass);

    // Brushed snare, approximated. A real brush is a texture; this is a
    // filtered noise puff, which is exactly what a sound card would give you.
    this.brush = new Tone.NoiseSynth({
      noise: { type: 'pink' },
      envelope: { attack: 0.006, decay: 0.11, sustain: 0 },
      volume: -26,
    }).connect(this.gains.drums);

    this.rim = new Tone.MembraneSynth({
      pitchDecay: 0.008,
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.12, sustain: 0 },
      volume: -22,
    }).connect(this.gains.drums);

    this.trumpet = new Tone.FMSynth({
      harmonicity: 3,
      modulationIndex: 11,
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.05, decay: 0.2, sustain: 0.5, release: 0.4 },
      volume: -19,
    }).connect(this.gains.vibes);

    this.vibes = new Tone.FMSynth({
      harmonicity: 4,
      modulationIndex: 3,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.01, decay: 1.4, sustain: 0, release: 1.2 },
      volume: -21,
    }).connect(this.gains.vibes);

    const transport = Tone.getTransport();
    transport.bpm.value = BPM;
    transport.swing = 0.08;
    transport.swingSubdivision = '8n';

    // One step per bar; the callback places the off-beat hits itself.
    this.sequence = new Tone.Sequence(
      (time, bar) => this.playBar(time, bar),
      [0, 1, 2, 3, 4, 5, 6, 7],
      '1m'
    );
    this.sequence.loop = true;

    this.ready = true;
  }

  private playBar(time: number, bar: number): void {
    const beat = 60 / BPM;
    const chord = CHORDS[bar];

    for (const b of COMP_BEATS) {
      this.rhodes.triggerAttackRelease(chord, '4n', time + b * beat);
    }

    // Bossa bass: root on one, fifth anticipating beat three.
    this.bass.triggerAttackRelease(ROOTS[bar], '4n.', time);
    this.bass.triggerAttackRelease(FIFTHS[bar], '4n.', time + 2.5 * beat);

    // Brush on every beat, rim on the clave accents.
    for (let b = 0; b < 4; b++) {
      this.brush.triggerAttackRelease('16n', time + b * beat);
    }
    this.rim.triggerAttackRelease('C4', '32n', time + 1.5 * beat);
    this.rim.triggerAttackRelease('C4', '32n', time + 3 * beat);

    // Garnish layer: a lazy trumpet note, and a vibes tail every other bar.
    this.trumpet.triggerAttackRelease(TRUMPET[bar], '2n', time + 2 * beat);
    if (bar % 2 === 0) {
      this.vibes.triggerAttackRelease(chord[2], '2n', time + 3.5 * beat);
    }
  }

  /**
   * Browsers will not start audio without a user gesture, so this must be
   * called from a click handler. Safe to call repeatedly.
   */
  async start(): Promise<void> {
    this.build();
    if (this.started) return;
    await Tone.start();
    Tone.getTransport().start();
    this.sequence?.start(0);
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    this.sequence?.stop();
    Tone.getTransport().stop();
    this.started = false;
  }

  get playing(): boolean {
    return this.started;
  }

  /** Fade a layer in or out. Ramped, so toggling mid-bar is not a click. */
  setLayer(layer: Layer, on: boolean): void {
    this.enabled[layer] = on;
    if (!this.ready) return;
    this.gains[layer].gain.rampTo(on ? 1 : 0, 0.4);
  }

  isLayerOn(layer: Layer): boolean {
    return this.enabled[layer];
  }

  /**
   * Duck the music briefly. Use for moments that need air — NOT for failure,
   * which the music must ignore entirely.
   */
  duck(seconds = 1.2): void {
    if (!this.ready) return;
    this.master.volume.rampTo(-26, 0.15);
    this.master.volume.rampTo(-9, 0.6, `+${seconds}`);
  }

  /**
   * Period-correct system sounds, synthesised rather than sampled. Windows 95
   * WAVs are Microsoft's assets — these are equivalents built from scratch,
   * same rule as the sprites (see ART.md).
   */
  sfx(kind: Sfx): void {
    this.build();
    if (Tone.getContext().state !== 'running') return;
    const now = Tone.now();

    if (kind === 'stamp') {
      // Rubber stamp: a wooden knock, not a beep.
      const knock = new Tone.MembraneSynth({
        pitchDecay: 0.02,
        octaves: 4,
        envelope: { attack: 0.001, decay: 0.09, sustain: 0 },
        volume: -14,
      }).connect(this.speaker);
      knock.triggerAttackRelease('A2', '32n', now);
      setTimeout(() => knock.dispose(), 600);
      return;
    }

    if (kind === 'correct') {
      // Two-tone bell, rising. The sound of a form being accepted.
      const bell = new Tone.FMSynth({
        harmonicity: 3.2,
        modulationIndex: 9,
        envelope: { attack: 0.002, decay: 0.5, sustain: 0, release: 0.4 },
        volume: -14,
      }).connect(this.speaker);
      bell.triggerAttackRelease('E5', '16n', now);
      bell.triggerAttackRelease('A5', '8n', now + 0.11);
      setTimeout(() => bell.dispose(), 1400);
      return;
    }

    if (kind === 'invalid') {
      // The flat, unbothered two-note thud of a dialog you cannot dismiss.
      const thud = new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 1.5,
        modulationIndex: 4,
        envelope: { attack: 0.004, decay: 0.35, sustain: 0, release: 0.3 },
        volume: -16,
      }).connect(this.speaker);
      thud.triggerAttackRelease(['C4', 'F#4'], '8n', now);
      setTimeout(() => thud.dispose(), 1200);
      return;
    }

    // reveal — a distant, muffled boom. It happened in another building and
    // nobody in this one looked up.
    const boom = new Tone.NoiseSynth({
      noise: { type: 'brown' },
      envelope: { attack: 0.01, decay: 0.7, sustain: 0 },
      volume: -13,
    }).connect(this.room);
    boom.triggerAttackRelease('2n', now);
    setTimeout(() => boom.dispose(), 2200);
  }
}

export const soundtrack = new Soundtrack();
