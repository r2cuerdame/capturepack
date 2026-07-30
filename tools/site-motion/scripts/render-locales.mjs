import {mkdirSync, renameSync, rmSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const ALL_LOCALES = ['en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru'];
const requested = process.argv.slice(2);
const locales = requested.length ? requested : ALL_LOCALES;
const unknown = locales.filter((locale) => !ALL_LOCALES.includes(locale));
if (unknown.length) {
  throw new Error(`Unsupported locale(s): ${unknown.join(', ')}`);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const compositions = [
  {id: 'TimeMachine', file: 'capturepack-time-machine', posterFrame: 22},
  {id: 'StillContext', file: 'capturepack-still-context', posterFrame: 100},
];

const run = (command, args) => {
  const result = spawnSync(command, args, {stdio: 'inherit', shell: false});
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
};

run('ffmpeg', ['-version']);
if (requested.length) {
  for (const locale of locales) {
    rmSync(join('out', 'i18n', locale), {recursive: true, force: true});
  }
} else {
  rmSync(join('out', 'i18n'), {recursive: true, force: true});
}

for (const locale of locales) {
  const dir = join('out', 'i18n', locale);
  mkdirSync(dir, {recursive: true});
  const props = JSON.stringify({locale});

  for (const composition of compositions) {
    const rawMp4 = join(dir, `${composition.file}.raw.mp4`);
    const mp4 = join(dir, `${composition.file}.mp4`);
    const fastMp4 = join(dir, `${composition.file}.fast.mp4`);
    const webm = join(dir, `${composition.file}.webm`);
    const posterPng = join(dir, `${composition.file}-poster.png`);
    const posterWebp = join(dir, `${composition.file}-poster.webp`);

    run(npx, [
      'remotion', 'render', 'src/index.tsx', composition.id, rawMp4,
      '--props', props,
      '--codec=h264', '--crf=20', '--pixel-format=yuv420p',
    ]);
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', rawMp4,
      '-c', 'copy', '-movflags', '+faststart', fastMp4,
    ]);
    unlinkSync(rawMp4);
    renameSync(fastMp4, mp4);

    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', mp4, '-an',
      '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0',
      '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', webm,
    ]);

    run(npx, [
      'remotion', 'still', 'src/index.tsx', composition.id, posterPng,
      `--frame=${composition.posterFrame}`, '--props', props,
    ]);
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', posterPng,
      '-vf', 'scale=960:540:flags=lanczos',
      '-c:v', 'libwebp', '-quality', '84', posterWebp,
    ]);
    unlinkSync(posterPng);
  }
  console.log(`[CapturePack motion] ${locale} complete`);
}

console.log(`[CapturePack motion] rendered ${locales.length} locale(s)`);
