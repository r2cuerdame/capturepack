import React, {CSSProperties, ReactNode} from 'react';
import {
  AbsoluteFill,
  Composition,
  Easing,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {COPY, MotionCopy, MotionLocale, localeFontFamily, safeLocale} from './copy';

const C = {
  bg: '#09090f',
  panel: '#111119',
  panel2: '#171722',
  line: '#30303d',
  text: '#f7f5ff',
  muted: '#a9a5b7',
  purple: '#7c5cff',
  purple2: '#b092ff',
  pink: '#ec4899',
  blue: '#0A84FF',
  red: '#ff5d6c',
  mint: '#51d6b2',
  amber: '#ffc857',
};

const CopyContext = React.createContext<MotionCopy>(COPY.en);
const useCopy = () => React.useContext(CopyContext);
type MotionProps = {locale?: MotionLocale};

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const progress = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
const fadeScene = (frame: number, duration: number, fade = 12) =>
  Math.min(
    interpolate(frame, [0, fade], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
    interpolate(frame, [duration - fade, duration], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
  );
const pop = (frame: number, fps: number, delay = 0) =>
  spring({frame: Math.max(0, frame - delay), fps, config: {damping: 16, stiffness: 150, mass: 0.8}});

const fontStyle = `
*{box-sizing:border-box}
`;

const BrandBackdrop: React.FC<{accent?: 'purple' | 'blue'}> = ({accent = 'purple'}) => (
  <AbsoluteFill
    style={{
      background:
        accent === 'purple'
          ? 'radial-gradient(circle at 72% 12%, rgba(124,92,255,.18), transparent 34%), radial-gradient(circle at 8% 88%, rgba(236,72,153,.09), transparent 32%), #09090f'
          : 'radial-gradient(circle at 80% 12%, rgba(10,132,255,.16), transparent 34%), radial-gradient(circle at 12% 88%, rgba(124,92,255,.13), transparent 34%), #09090f',
      overflow: 'hidden',
    }}
  >
    <div
      style={{
        position: 'absolute',
        inset: 0,
        opacity: 0.16,
        backgroundImage:
          'linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px)',
        backgroundSize: '56px 56px',
        maskImage: 'linear-gradient(to bottom,black,transparent 90%)',
      }}
    />
    <div
      style={{
        position: 'absolute',
        width: 520,
        height: 520,
        right: -240,
        top: -250,
        border: '1px solid rgba(176,146,255,.18)',
        borderRadius: '50%',
      }}
    />
    <div
      style={{
        position: 'absolute',
        width: 400,
        height: 400,
        right: -180,
        top: -190,
        border: '1px solid rgba(176,146,255,.14)',
        borderRadius: '50%',
      }}
    />
  </AbsoluteFill>
);

const BrandMark: React.FC<{size?: number; label?: boolean}> = ({size = 54, label = true}) => (
  <div style={{display: 'flex', alignItems: 'center', gap: 15}}>
    <Img
      src={staticFile('icon.png')}
      style={{width: size, height: size, borderRadius: size * 0.22, boxShadow: `0 10px 36px rgba(124,92,255,.34)`}}
    />
    {label ? <div style={{fontWeight: 780, fontSize: size * 0.43, letterSpacing: '-.035em'}}>CapturePack</div> : null}
  </div>
);

const Chrome: React.FC<{children: ReactNode; style?: CSSProperties; title?: string}> = ({children, style, title = 'Project settings'}) => (
  <div
    style={{
      position: 'relative',
      overflow: 'hidden',
      background: '#f7f7fa',
      border: '1px solid #d7d7df',
      borderRadius: 18,
      boxShadow: '0 28px 80px rgba(0,0,0,.38)',
      ...style,
    }}
  >
    <div style={{height: 44, background: '#e9e9ef', borderBottom: '1px solid #d2d2dc', display: 'flex', alignItems: 'center', padding: '0 16px', gap: 8}}>
      <span style={{width: 10, height: 10, borderRadius: '50%', background: '#ff6b65'}} />
      <span style={{width: 10, height: 10, borderRadius: '50%', background: '#ffc14f'}} />
      <span style={{width: 10, height: 10, borderRadius: '50%', background: '#35ce6b'}} />
      <span style={{marginLeft: 10, color: '#4c4c59', fontSize: 14, fontWeight: 650}}>{title}</span>
    </div>
    {children}
  </div>
);

const AppMock: React.FC<{
  width?: number;
  errorOpacity?: number;
  selection?: 'none' | 'object' | 'manual' | 'both';
  dim?: number;
  layerOnly?: boolean;
}> = ({width = 680, errorOpacity = 0, selection = 'none', dim = 1, layerOnly = false}) => {
  const t = useCopy();
  const height = width * 0.57;
  const body = (
    <div style={{position: 'relative', height: height - 44, opacity: dim}}>
      <div style={{position: 'absolute', left: 0, top: 0, bottom: 0, width: '27%', background: '#ececf2', borderRight: '1px solid #d8d8e0', padding: '28px 24px'}}>
        {[74, 96, 68, 84, 59].map((w, i) => (
          <div key={i} style={{height: i === 0 ? 10 : 8, width: `${w}%`, marginBottom: 22, borderRadius: 99, background: i === 0 ? '#7b7b88' : '#c1c1cb'}} />
        ))}
      </div>
      <div style={{position: 'absolute', left: '27%', right: 0, top: 0, bottom: 0, padding: '27px 34px', color: '#2d2d38'}}>
        <div style={{fontSize: 20, fontWeight: 760, letterSpacing: '-.02em'}}>Notifications</div>
        <div style={{fontSize: 12.5, color: '#858590', marginTop: 7}}>Send a summary after each capture</div>
        <div style={{position: 'absolute', right: 38, top: 30, width: 46, height: 25, borderRadius: 16, background: C.purple}}>
          <span style={{position: 'absolute', right: 4, top: 4, width: 17, height: 17, borderRadius: '50%', background: '#fff'}} />
        </div>
        <div style={{height: 1, background: '#dedee5', marginTop: 28}} />
        <div style={{fontSize: 16, fontWeight: 700, marginTop: 24}}>Autosave project</div>
        <div style={{fontSize: 12.5, color: '#858590', marginTop: 7}}>Keep preferences when the workspace closes</div>
        <div style={{height: 42, borderRadius: 9, border: '1px solid #d8d8e1', background: '#fff', marginTop: 22, display: 'flex', alignItems: 'center', padding: '0 14px', color: '#8c8c98', fontSize: 13}}>Workspace name</div>
        <button style={{position: 'absolute', right: 34, bottom: 26, border: 0, color: '#fff', background: C.purple, fontWeight: 760, fontSize: 13.5, borderRadius: 9, padding: '12px 22px'}}>{t.saveChanges}</button>
        <div style={{position: 'absolute', right: 34, top: 98, width: 235, height: 66, borderRadius: 12, background: '#fff1f3', border: `1px solid ${C.red}`, boxShadow: '0 14px 35px rgba(110,25,38,.16)', opacity: errorOpacity, transform: `translateY(${(1 - errorOpacity) * -12}px) scale(${0.96 + errorOpacity * 0.04})`, padding: '13px 16px'}}>
          <div style={{fontSize: 13, color: '#9a263b', fontWeight: 780}}>Save failed</div>
          <div style={{fontSize: 11.5, color: '#a45c69', marginTop: 5}}>Changes were not written.</div>
        </div>
        {/* A REPLAY DOES NOT PICK (decided 2026-08-01). This box is DRAWN, so it
            says so; the still-image film below still shows a real object pick,
            because there it is still true. */}
        {(selection === 'object' || selection === 'both') && (
          <div style={{position: 'absolute', right: 28, bottom: 20, width: 143, height: 54, borderRadius: 12, border: `3px solid ${C.blue}`, boxShadow: `0 0 0 5px rgba(10,132,255,.12), 0 0 28px rgba(10,132,255,.38)`}}>
            <span style={{position: 'absolute', top: -28, right: 0, color: '#fff', background: C.blue, padding: '5px 9px', borderRadius: 6, fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em'}}>{t.markedBox}</span>
          </div>
        )}
        {(selection === 'manual' || selection === 'both') && (
          <div style={{position: 'absolute', right: 26, top: 91, width: 251, height: 80, borderRadius: 14, border: `3px solid ${C.red}`, boxShadow: `0 0 0 5px rgba(255,93,108,.10)`}}>
            <span style={{position: 'absolute', top: -28, left: 0, color: '#fff', background: C.red, padding: '5px 9px', borderRadius: 6, fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em'}}>{t.manualNote}</span>
          </div>
        )}
      </div>
    </div>
  );

  if (layerOnly) {
    return (
      <div style={{position: 'relative', width, height, background: 'repeating-conic-gradient(rgba(255,255,255,.055) 0 25%, transparent 0 50%) 50%/28px 28px', border: '1px solid rgba(255,255,255,.14)', borderRadius: 18, boxShadow: '0 28px 80px rgba(0,0,0,.38)'}}>
        <div style={{position: 'absolute', right: '6%', top: '24%', width: '41%', height: '22%', borderRadius: 14, border: `3px solid ${C.red}`, boxShadow: `0 0 0 6px rgba(255,93,108,.10), 0 0 32px rgba(255,93,108,.18)`}}>
          <span style={{position: 'absolute', top: -30, left: 0, color: '#fff', background: C.red, padding: '6px 10px', borderRadius: 7, fontSize: 11, fontWeight: 800, letterSpacing: '.06em'}}>{t.manualNote}</span>
          <span style={{position: 'absolute', left: 16, top: 17, color: '#ffd9dd', fontSize: 15, fontWeight: 700}}>{t.manualQuote}</span>
        </div>
        <div style={{position: 'absolute', right: '6%', bottom: '13%', width: '30%', height: '17%', borderRadius: 12, border: `3px solid ${C.blue}`, boxShadow: `0 0 0 6px rgba(10,132,255,.11), 0 0 34px rgba(10,132,255,.28)`}}>
          <span style={{position: 'absolute', top: -30, right: 0, color: '#fff', background: C.blue, padding: '6px 10px', borderRadius: 7, fontSize: 11, fontWeight: 800, letterSpacing: '.06em'}}>{t.objectPick}</span>
          <span style={{position: 'absolute', left: 16, top: 12, color: '#d7edff', fontSize: 15, fontWeight: 700}}>{t.saveChanges} · {t.button}</span>
        </div>
        <div style={{position: 'absolute', left: '7%', top: '12%', color: '#9792a5', fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13, lineHeight: 1.75}}>bounds · lifetime · note<br/>target name · role · state</div>
      </div>
    );
  }

  return <Chrome style={{width, height}}>{body}</Chrome>;
};

const KeyChord: React.FC<{keys: string[]; accent?: string; scale?: number}> = ({keys, accent = C.purple, scale = 1}) => (
  <div style={{display: 'flex', alignItems: 'center', gap: 10, transform: `scale(${scale})`, transformOrigin: 'left center'}}>
    {keys.map((k, i) => (
      <React.Fragment key={k}>
        {i > 0 ? <span style={{color: C.muted, fontSize: 18}}>+</span> : null}
        <span style={{minWidth: 52, textAlign: 'center', padding: '10px 13px', borderRadius: 10, color: '#fff', background: '#1d1d27', border: `1px solid ${i === keys.length - 1 ? accent : '#3b3b49'}`, boxShadow: i === keys.length - 1 ? `0 0 26px ${accent}55` : 'inset 0 -3px 0 rgba(0,0,0,.35)', fontWeight: 760, fontSize: 14}}>{k}</span>
      </React.Fragment>
    ))}
  </div>
);

const Kicker: React.FC<{children: ReactNode; color?: string}> = ({children, color = C.purple2}) => (
  <div style={{fontSize: 14, letterSpacing: '.15em', fontWeight: 850, color, textTransform: 'uppercase'}}>{children}</div>
);

const Headline: React.FC<{children: ReactNode; size?: number; style?: CSSProperties}> = ({children, size = 56, style}) => (
  <div style={{fontSize: size, lineHeight: 1.02, fontWeight: 820, letterSpacing: '-.048em', color: C.text, ...style}}>{children}</div>
);

const Timeline: React.FC<{rewind: number; left?: number; top?: number; width?: number}> = ({rewind, left = 280, top = 600, width = 720}) => {
  const x = width - 22 - rewind * (width * 0.58);
  return (
    <div style={{position: 'absolute', left, top, width, height: 78, padding: '14px 18px', borderRadius: 14, background: 'rgba(17,17,25,.96)', border: '1px solid #343442', boxShadow: '0 18px 50px rgba(0,0,0,.28)'}}>
      <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 760, color: '#868393', letterSpacing: '.09em'}}>
        <span>−30s</span><span style={{color: rewind > 0.65 ? C.mint : C.red}}>{rewind > 0.65 ? '8s AGO' : 'NOW'}</span>
      </div>
      <div style={{position: 'relative', marginTop: 12, height: 10, borderRadius: 99, background: '#2c2c38', overflow: 'visible'}}>
        <div style={{position: 'absolute', inset: 0, borderRadius: 99, background: 'linear-gradient(90deg,rgba(124,92,255,.12),rgba(124,92,255,.8))'}} />
        <div style={{position: 'absolute', width: 3, height: 30, left: x, top: -10, background: '#fff', boxShadow: '0 0 18px rgba(255,255,255,.65)'}} />
        <div style={{position: 'absolute', left: x - 7, top: -4, width: 17, height: 17, borderRadius: '50%', background: '#fff'}} />
        <div style={{position: 'absolute', right: 0, top: -5, width: 2, height: 20, background: C.red, opacity: 0.8}} />
      </div>
      <div style={{marginTop: 10, textAlign: 'center', fontSize: 10.5, color: C.purple2, fontWeight: 800, letterSpacing: '.08em'}}>← REWIND THE CAPTURED MOMENT</div>
    </div>
  );
};

const TimeIntro: React.FC<{duration: number}> = ({duration}) => {
  const t = useCopy();
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const opacity = fadeScene(frame, duration);
  const title = pop(frame, fps, 14);
  const chord = pop(frame, fps, 31);
  const errorOpacity = 1 - progress(frame, 2, 14);
  return (
    <AbsoluteFill style={{opacity, padding: 54}}>
      <BrandMark size={48} />
      <div style={{position: 'absolute', left: 66, top: 195, width: 470, transform: `translateY(${(1 - title) * 28}px)`, opacity: title}}>
        <Kicker>{t.liveKicker}</Kicker>
        <Headline style={{marginTop: 18, whiteSpace: 'pre-line'}}>{t.bugGone}</Headline>
        <div style={{marginTop: 22, fontSize: 24, color: C.muted, fontWeight: 560}}>{t.noRepro} <span style={{color: C.text, fontWeight: 760}}>{t.rewindIt}</span></div>
        <div style={{marginTop: 36, opacity: chord, transform: `translateY(${(1 - chord) * 18}px)`}}><KeyChord keys={['Ctrl', 'Alt', 'C']} /></div>
      </div>
      <div style={{position: 'absolute', left: 605, top: 137, transform: `scale(${0.94 + title * 0.06}) rotateY(${(1 - title) * -5}deg)`, transformOrigin: 'center'}}>
        <AppMock width={610} errorOpacity={errorOpacity} />
        <div style={{position: 'absolute', left: 22, bottom: -26, display: 'flex', alignItems: 'center', gap: 9, border: `1px solid rgba(81,214,178,.35)`, background: '#13251f', color: '#bff5e6', padding: '9px 13px', borderRadius: 99, fontWeight: 720, fontSize: 12}}>
          <span style={{width: 8, height: 8, borderRadius: '50%', background: C.mint, boxShadow: `0 0 14px ${C.mint}`}} /> LAST 30s READY
        </div>
      </div>
    </AbsoluteFill>
  );
};

const RewindPick: React.FC<{duration: number}> = ({duration}) => {
  const t = useCopy();
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const opacity = fadeScene(frame, duration);
  const rewind = progress(frame, 12, 54);
  const picked = pop(frame, fps, 57);
  const manual = pop(frame, fps, 83);
  const select: 'none' | 'object' | 'both' = picked < 0.2 ? 'none' : manual > 0.35 ? 'both' : 'object';
  return (
    <AbsoluteFill style={{opacity}}>
      <div style={{position: 'absolute', left: 58, top: 42}}>
        <Kicker>{t.noRerun}</Kicker>
        <Headline size={42} style={{marginTop: 10}}>{t.rewindMoment}</Headline>
      </div>
      <div style={{position: 'absolute', right: 58, top: 55, opacity: interpolate(frame, [0, 12], [0, 1], {extrapolateRight: 'clamp'})}}>
        <KeyChord keys={['Ctrl', 'Alt', 'C']} scale={0.83} />
      </div>
      <div style={{position: 'absolute', left: 86, top: 138, transform: `translateX(${picked * -38}px) scale(${1 - picked * 0.065})`, transformOrigin: 'left top'}}>
        <AppMock width={820} errorOpacity={rewind} selection={select} />
      </div>
      <Timeline rewind={rewind} left={100} top={615} width={790} />
      <div style={{position: 'absolute', left: 956, top: 162, width: 270, opacity: picked, transform: `translateX(${(1 - picked) * 44}px)`}}>
        <div style={{padding: '18px 18px 20px', background: '#12121a', border: `1px solid ${C.blue}88`, borderRadius: 16, boxShadow: '0 28px 70px rgba(0,0,0,.32)'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 10, color: '#cfe8ff', fontSize: 12, fontWeight: 820, letterSpacing: '.09em'}}><span style={{width: 9, height: 9, background: C.blue, borderRadius: '50%', boxShadow: `0 0 15px ${C.blue}`}} /> {t.recordedContext}</div>
          {[['NAME', t.saveChanges], ['ROLE', t.button], ['STATE', t.visibleAgo]].map(([k, v]) => (
            <div key={k} style={{marginTop: 18}}><div style={{fontSize: 10, color: '#777384', fontWeight: 800, letterSpacing: '.12em'}}>{k}</div><div style={{fontSize: 16, color: C.text, fontWeight: 680, marginTop: 4}}>{v}</div></div>
          ))}
        </div>
        <div style={{marginTop: 15, padding: '15px 17px', background: '#201216', border: `1px solid ${C.red}77`, borderRadius: 14, opacity: manual, transform: `translateY(${(1 - manual) * 22}px)`}}>
          <div style={{fontSize: 10, color: '#ffb8c0', fontWeight: 820, letterSpacing: '.1em'}}>{t.manualNote}</div>
          <div style={{fontSize: 14.5, color: '#fff0f2', marginTop: 7, lineHeight: 1.35}}>{t.manualQuote}</div>
        </div>
      </div>
      <div style={{position: 'absolute', right: 58, bottom: 34, color: manual > 0.45 ? C.red : C.blue, fontWeight: 790, fontSize: 18, letterSpacing: '-.02em'}}>{manual > 0.45 ? t.boxOrNote : t.markMoment}</div>
    </AbsoluteFill>
  );
};

const FlowCard: React.FC<{label: string; detail: string; color: string; x: number; y: number; enter: number}> = ({label, detail, color, x, y, enter}) => (
  <div style={{position: 'absolute', left: x, top: y, width: 235, height: 105, borderRadius: 16, background: '#15151f', border: `1px solid ${color}88`, padding: '18px 20px', opacity: enter, transform: `translateX(${(1 - enter) * -45}px) scale(${0.9 + enter * 0.1})`, boxShadow: '0 22px 55px rgba(0,0,0,.3)'}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color, fontWeight: 850, letterSpacing: '.12em'}}><span style={{width: 10, height: 10, borderRadius: 3, background: color, boxShadow: `0 0 18px ${color}`}} />{label}</div>
    <div style={{marginTop: 12, color: C.text, fontSize: 16, fontWeight: 650}}>{detail}</div>
  </div>
);

const PackFlow: React.FC<{duration: number}> = ({duration}) => {
  const t = useCopy();
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const opacity = fadeScene(frame, duration);
  const e1 = pop(frame, fps, 2), e2 = pop(frame, fps, 9), e3 = pop(frame, fps, 16);
  const folder = pop(frame, fps, 27), ai = pop(frame, fps, 43);
  return (
    <AbsoluteFill style={{opacity}}>
      <div style={{position: 'absolute', left: 64, top: 54}}><Kicker>{t.packKicker}</Kicker><Headline size={48} style={{marginTop: 12}}>{t.packTitle}</Headline></div>
      <FlowCard label="REPLAY" detail={t.momentBefore} color={C.purple2} x={76} y={220} enter={e1} />
      <FlowCard label="OBJECT" detail={t.nameRoleState} color={C.blue} x={76} y={345} enter={e2} />
      <FlowCard label="INTENT" detail={t.yourAnnotation} color={C.red} x={76} y={470} enter={e3} />
      {[325, 450, 575].map((y, i) => <div key={y} style={{position: 'absolute', left: 325, top: y, width: 188, height: 2, background: `linear-gradient(90deg,${[C.purple2,C.blue,C.red][i]},${C.purple})`, opacity: [e1,e2,e3][i], transformOrigin: 'left', transform: `scaleX(${progress(frame, 20 + i * 4, 43 + i * 4)})`}} />)}
      <div style={{position: 'absolute', left: 505, top: 281, width: 310, height: 245, borderRadius: 28, background: 'linear-gradient(145deg,#7c5cff,#5537db)', boxShadow: '0 34px 90px rgba(124,92,255,.36)', opacity: folder, transform: `scale(${0.78 + folder * .22}) rotate(${(1 - folder) * -4}deg)`, padding: 28}}>
        <div style={{position: 'absolute', left: 0, top: -23, width: 132, height: 52, borderRadius: '18px 18px 0 0', background: '#7c5cff'}} />
        <BrandMark size={48} label={false} />
        <div style={{fontSize: 28, fontWeight: 820, marginTop: 22, letterSpacing: '-.03em'}}>CapturePack</div>
        <div style={{fontFamily: 'Cascadia Mono, Consolas, monospace', marginTop: 16, fontSize: 13, lineHeight: 1.8, color: '#e6ddff'}}>replay.mp4<br />annotations.json<br />plugins/ · report.md</div>
      </div>
      <div style={{position: 'absolute', left: 817, top: 403, width: 92, height: 2, background: `linear-gradient(90deg,${C.purple},${C.mint})`, transformOrigin: 'left', transform: `scaleX(${ai})`}} />
      <div style={{position: 'absolute', right: 64, top: 264, width: 306, height: 280, borderRadius: 22, background: '#121a18', border: `1px solid ${C.mint}77`, boxShadow: '0 30px 80px rgba(0,0,0,.34)', opacity: ai, transform: `translateX(${(1 - ai) * 52}px)`, padding: 26}}>
        <div style={{color: C.mint, fontSize: 12, fontWeight: 850, letterSpacing: '.13em'}}>{t.aiReady}</div>
        <div style={{marginTop: 22, fontSize: 25, fontWeight: 760, lineHeight: 1.2, letterSpacing: '-.03em'}}>{t.aiExact}<br />{t.aiRealObject}<br />{t.aiWhatMeant}</div>
        <div style={{marginTop: 25, height: 1, background: '#264139'}} />
        <div style={{marginTop: 18, color: '#a8c7be', fontSize: 14, lineHeight: 1.45}}>{t.noGuess}</div>
      </div>
    </AbsoluteFill>
  );
};

const EndCard: React.FC<{duration: number; secondLine: string}> = ({duration, secondLine}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const opacity = fadeScene(frame, duration, 8);
  const s = pop(frame, fps, 2);
  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity}}>
      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', transform: `scale(${0.86 + s * .14})`, opacity: s}}>
        <BrandMark size={76} label={false} />
        <Headline size={52} style={{marginTop: 27, textAlign: 'center'}}>Capture context,<br />not screenshots.</Headline>
        <div style={{marginTop: 20, color: C.purple2, fontSize: 18, fontWeight: 720, letterSpacing: '.02em'}}>{secondLine}</div>
      </div>
    </AbsoluteFill>
  );
};

const TimeMachine: React.FC<MotionProps> = ({locale}) => {
  const lang = safeLocale(locale);
  const t = COPY[lang];
  return (
    <CopyContext.Provider value={t}>
      <AbsoluteFill style={{fontFamily: localeFontFamily(lang), color: C.text}}>
        <style>{fontStyle}</style>
        <BrandBackdrop accent="purple" />
        <Sequence from={0} durationInFrames={70}><TimeIntro duration={70} /></Sequence>
        <Sequence from={58} durationInFrames={116}><RewindPick duration={116} /></Sequence>
        <Sequence from={162} durationInFrames={78}><PackFlow duration={78} /></Sequence>
        <Sequence from={226} durationInFrames={44}><EndCard duration={44} secondLine={t.endTime} /></Sequence>
      </AbsoluteFill>
    </CopyContext.Provider>
  );
};

const RegionIntro: React.FC<{duration: number}> = ({duration}) => {
  const t = useCopy();
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const opacity = fadeScene(frame, duration);
  const e = pop(frame, fps, 2);
  const select = progress(frame, 24, 52);
  return (
    <AbsoluteFill style={{opacity}}>
      <div style={{position: 'absolute', left: 58, top: 48}}><BrandMark size={46} /></div>
      <div style={{position: 'absolute', left: 70, top: 185, width: 450, opacity: e, transform: `translateY(${(1-e)*25}px)`}}>
        <Kicker color={C.blue}>{t.oneFrame}</Kicker>
        <Headline style={{marginTop: 17, whiteSpace: 'pre-line'}}>{t.moreThan}</Headline>
        <div style={{marginTop: 26, fontSize: 22, color: C.muted}}>{t.capturePixels}<br /><span style={{color: C.text, fontWeight: 740}}>{t.addMeaning}</span></div>
        <div style={{marginTop: 33}}><KeyChord keys={['Ctrl', 'Alt', 'S']} accent={C.blue} /></div>
      </div>
      <div style={{position: 'absolute', left: 565, top: 132}}>
        <AppMock width={650} />
        <div style={{position: 'absolute', left: 80 + select * 108, top: 88 + select * 28, width: 420 - select * 95, height: 235 - select * 35, border: `3px solid ${C.blue}`, borderRadius: 10, boxShadow: `0 0 0 999px rgba(5,6,12,${0.08 + select * 0.45}), 0 0 34px rgba(10,132,255,.42)`, opacity: select}}>
          {['tl','tr','bl','br'].map((k, i) => <span key={k} style={{position:'absolute', width: 13, height:13, background:'#fff', border:`2px solid ${C.blue}`, borderRadius:3, left:i%2===0?-7:undefined,right:i%2===1?-7:undefined,top:i<2?-7:undefined,bottom:i>=2?-7:undefined}} />)}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const LayerScene: React.FC<{duration: number}> = ({duration}) => {
  const t = useCopy();
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const opacity = fadeScene(frame, duration);
  const original = pop(frame, fps, 2), layer = pop(frame, fps, 16);
  return (
    <AbsoluteFill style={{opacity}}>
      <div style={{position: 'absolute', left: 64, top: 45}}><Kicker color={C.blue}>{t.nonDestructive}</Kicker><Headline size={43} style={{marginTop: 10}}>{t.pixelsOriginal}<br />{t.contextEditable}</Headline></div>
      <div style={{position:'absolute',left:92,top:238,opacity:original,transform:`translateX(${(1-original)*-40}px)`}}>
        <div style={{transform:'scale(.69)', transformOrigin:'left top'}}><AppMock width={680} /></div>
        <div style={{position:'absolute',left:18,top:300,padding:'10px 14px',borderRadius:99,background:'#171720',border:'1px solid #3a3a46',fontFamily:'Cascadia Mono,Consolas,monospace',fontSize:12,color:'#d9d7e2'}}><span style={{color:C.mint}}>●</span> snapshot.png · ORIGINAL</div>
      </div>
      <div style={{position:'absolute',right:75,top:221,opacity:layer,transform:`translateX(${(1-layer)*48}px) rotateY(-4deg)`}}>
        <div style={{transform:'scale(.69)', transformOrigin:'left top'}}><AppMock width={680} errorOpacity={1} selection="both" layerOnly /></div>
        <div style={{position:'absolute',left:18,top:300,padding:'10px 14px',borderRadius:99,background:'#161729',border:`1px solid ${C.purple}88`,fontFamily:'Cascadia Mono,Consolas,monospace',fontSize:12,color:'#e8e2ff'}}><span style={{color:C.purple2}}>◆</span> annotations.json · EDITABLE</div>
      </div>
      <div style={{position:'absolute',left:560,top:401,width:150,height:2,background:`linear-gradient(90deg,${C.mint},${C.purple})`,transform:`scaleX(${layer})`,transformOrigin:'left'}} />
      <div style={{position:'absolute',left:575,top:370,color:'#8c8999',fontSize:11,fontWeight:800,letterSpacing:'.12em',opacity:layer}}>{t.separateLayer}</div>
    </AbsoluteFill>
  );
};

const AIContextScene: React.FC<{duration: number}> = ({duration}) => {
  const t = useCopy();
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const opacity = fadeScene(frame, duration);
  const f1 = pop(frame, fps, 3), f2 = pop(frame, fps, 11), f3 = pop(frame, fps, 19), ai = pop(frame, fps, 36);
  return (
    <AbsoluteFill style={{opacity}}>
      <div style={{position:'absolute',left:65,top:55}}><Kicker color={C.blue}>PIXELS + INTENT</Kicker><Headline size={48} style={{marginTop:11}}>{t.wholeExplanation}</Headline></div>
      <FlowCard label="SNAPSHOT.PNG" detail={t.originalPixels} color={C.mint} x={78} y={237} enter={f1} />
      <FlowCard label="ANNOTATIONS.JSON" detail={t.boxesNotes} color={C.red} x={78} y={362} enter={f2} />
      <FlowCard label="OBJECT CONTEXT" detail="Name + role" color={C.blue} x={78} y={487} enter={f3} />
      {[342,467,592].map((y,i)=><div key={y} style={{position:'absolute',left:327,top:y,width:180,height:2,background:`linear-gradient(90deg,${[C.mint,C.red,C.blue][i]},${C.purple})`,transformOrigin:'left',transform:`scaleX(${progress(frame,22+i*4,45+i*4)})`,opacity:[f1,f2,f3][i]}} />)}
      <div style={{position:'absolute',left:508,top:236,width:284,height:356,borderRadius:26,background:'linear-gradient(145deg,#7c5cff,#5132d4)',boxShadow:'0 34px 90px rgba(124,92,255,.34)',opacity:pop(frame,fps,26),transform:`scale(${.82+pop(frame,fps,26)*.18})`,padding:28}}>
        <BrandMark size={48} label={false}/><div style={{fontSize:27,fontWeight:820,marginTop:22}}>CapturePack</div><div style={{fontFamily:'Cascadia Mono,Consolas,monospace',fontSize:13,lineHeight:1.9,color:'#e8e0ff',marginTop:18}}>snapshot.png<br/>annotations.json<br/>plugins/windows-uia/<br/>report.md</div>
      </div>
      <div style={{position:'absolute',left:794,top:408,width:90,height:2,background:`linear-gradient(90deg,${C.purple},${C.mint})`,transformOrigin:'left',transform:`scaleX(${ai})`}} />
      <div style={{position:'absolute',right:62,top:226,width:330,height:370,borderRadius:24,background:'#101b18',border:`1px solid ${C.mint}77`,boxShadow:'0 30px 80px rgba(0,0,0,.35)',padding:26,opacity:ai,transform:`translateX(${(1-ai)*52}px)`}}>
        <div style={{display:'flex',alignItems:'center',gap:10,color:C.mint,fontSize:12,fontWeight:850,letterSpacing:'.12em'}}><span style={{width:10,height:10,borderRadius:'50%',background:C.mint,boxShadow:`0 0 16px ${C.mint}`}}/>{t.aiUnderstands}</div>
        <div style={{marginTop:24,fontSize:23,fontWeight:760,lineHeight:1.28,letterSpacing:'-.025em',whiteSpace:'pre-line'}}>{t.aiQuote}</div>
        <div style={{height:1,background:'#29443d',marginTop:28}}/>
        <div style={{marginTop:20,color:'#a9c8c0',fontSize:14.5,lineHeight:1.55}}>{t.originalUntouched}<br/>{t.explanationBeside}</div>
      </div>
    </AbsoluteFill>
  );
};

const StillContext: React.FC<MotionProps> = ({locale}) => {
  const lang = safeLocale(locale);
  const t = COPY[lang];
  return (
    <CopyContext.Provider value={t}>
      <AbsoluteFill style={{fontFamily:localeFontFamily(lang),color:C.text}}>
        <style>{fontStyle}</style>
        <BrandBackdrop accent="blue" />
        <Sequence from={0} durationInFrames={64}><RegionIntro duration={64}/></Sequence>
        <Sequence from={64} durationInFrames={76}><LayerScene duration={76}/></Sequence>
        <Sequence from={140} durationInFrames={86}><AIContextScene duration={86}/></Sequence>
        <Sequence from={226} durationInFrames={50}><EndCard duration={50} secondLine={t.endStill}/></Sequence>
      </AbsoluteFill>
    </CopyContext.Provider>
  );
};

export const CapturePackMotionRoot: React.FC = () => (
  <>
    <Composition id="TimeMachine" component={TimeMachine} durationInFrames={270} fps={30} width={1280} height={720} />
    <Composition id="StillContext" component={StillContext} durationInFrames={276} fps={30} width={1280} height={720} />
  </>
);
