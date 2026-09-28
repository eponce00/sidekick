import { describe, expect, it } from 'vitest'
import { detectSpeechLanguage, speakableText } from './voiceText'

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
