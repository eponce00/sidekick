import { describe, expect, it } from 'vitest'
import { detectSpeechLanguage, speakableParagraphs, speakableText, speechChunks } from './voiceText'

describe('speakableText', () => {
  it('reads prose and leaves out what is read by eye', () => {
    const markdown = [
      '## Result',
      '',
      'The **build** passed. See [the log](https://example.com/log) and `npm test`',
      '',
      '```ts',
      'const secret = 1',
      '```',
      '',
      '- first item',
      '- second item',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| speed | fast |',
      '',
      '![chart](chart.png)',
      'Raw link https://example.com/x here.'
    ].join('\n')
    expect(speakableText(markdown)).toBe(
      'Result. The build passed. See the log and npm test. first item. second item. Name, Value. speed, fast. Raw link here.'
    )
  })

  it('leaves out reasoning written inline', () => {
    expect(speakableText('<think>Plan the reply first.</think>Done, it works.')).toBe(
      'Done, it works.'
    )
  })

  it('has nothing to read for a code-only reply', () => {
    expect(speakableText('```js\nconsole.log(1)\n```')).toBe('')
  })
})

describe('speakableParagraphs', () => {
  it('leaves out sources, citation marks and where a fact was reported', () => {
    const markdown = [
      'The grid failed again [1][2], Reuters reported (Oct 5).[^1] See reuters.com for more.',
      '',
      '## Sources',
      '- [Reuters](https://reuters.com/a) — blackout report',
      '- [Miami Herald](https://miamiherald.com/b)',
      '',
      'Sources: [AP](https://apnews.com/c)',
      '',
      '[^1]: A footnote with details.',
      '',
      'One more thing 【3†source】 to add.'
    ].join('\n')
    expect(speakableParagraphs(markdown)).toEqual([
      'The grid failed again, Reuters reported. See for more.',
      'One more thing to add.'
    ])
  })

  it('says symbols as words and gives a bold label its own sentence', () => {
    expect(
      speakableParagraphs(
        '**Energy crisis / blackouts** — The grid fell ~3 times → power is out & costs rose 5–10%, e.g. in Havana 🎉'
      )
    ).toEqual([
      'Energy crisis or blackouts. The grid fell about 3 times to power is out and costs rose 5 to 10%, for example, in Havana.'
    ])
  })

  it('keeps a bold phrase inside a line as words, and a continued line as one sentence', () => {
    expect(
      speakableParagraphs('- **Oct 7:** seized fuel worth **$3 million**\n— the second this week')
    ).toEqual(['Oct 7: seized fuel worth $3 million, the second this week.'])
  })

  it('says a path by its file name and keeps paragraphs apart', () => {
    expect(speakableParagraphs('Edit `src/power/grid.ts`.\r\n\r\nThen call `setYear()`.')).toEqual([
      'Edit grid.ts.',
      'Then call setYear.'
    ])
  })
})

describe('speechChunks', () => {
  it('packs sentences into passages within a paragraph, the first one short', () => {
    const sentence = 'This sentence is about forty characters.'
    const chunks = speechChunks(
      [`${sentence} ${sentence} ${sentence} ${sentence}`, 'Last one.'],
      90,
      50
    )
    expect(chunks).toEqual([
      { text: sentence, endsParagraph: false },
      { text: `${sentence} ${sentence}`, endsParagraph: false },
      { text: sentence, endsParagraph: true },
      { text: 'Last one.', endsParagraph: true }
    ])
  })
})

describe('detectSpeechLanguage', () => {
  it('tells English from Spanish replies', () => {
    expect(detectSpeechLanguage('The file is ready and the tests pass with this change.')).toBe(
      'en'
    )
    expect(
      detectSpeechLanguage('El archivo está listo y las pruebas pasan con este cambio para ti.')
    ).toBe('es')
  })

  it('recognizes languages with their own script', () => {
    expect(detectSpeechLanguage('こんにちは、ビルドは成功しました。')).toBe('ja')
    expect(detectSpeechLanguage('빌드가 성공했습니다.')).toBe('ko')
    expect(detectSpeechLanguage('Сборка прошла успешно, все тесты зелёные.')).toBe('ru')
    expect(detectSpeechLanguage('Збірка пройшла успішно, і всі тести зелені. Їх багато.')).toBe(
      'uk'
    )
    expect(detectSpeechLanguage('Η κατασκευή ολοκληρώθηκε με επιτυχία.')).toBe('el')
  })

  it('reads text with no clear language as English', () => {
    expect(detectSpeechLanguage('42 · 3.14')).toBe('en')
  })
})
