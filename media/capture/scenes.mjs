import { EVENING_EDITS, FORECAST } from './forecast-artifact.mjs'

// What the fake model does in each recorded scene, keyed by a phrase from the prompt that starts it.

const FORECAST_BUG =
  '  const fahrenheit = (celsius * 9) / 5 + 32\n  return `${Math.round(fahrenheit)}°F`'
const FORECAST_FIX =
  "  if (unit === 'C') return `${Math.round(celsius)}°C`\n" +
  '  const fahrenheit = (celsius * 9) / 5 + 32\n  return `${Math.round(fahrenheit)}°F`'

export const PROMPTS = {
  agent: 'The forecast card ignores the Celsius setting. Find the bug, fix it, and run the tests.',
  artifact: "Build a forecast for the station: today's reading, the week and the hours ahead.",
  edit: 'Switch it to the evening sky.',
  team: 'Split the follow-ups into two chats: one adds a test for negative readings, one documents the unit setting.'
}

export const SCENES = {
  'ignores the Celsius': [
    {
      waitMs: 500,
      thinking:
        'The unit reaches formatTemperature but the output is always °F, so the formatter probably never looks at it. Read it and run the tests to see what fails.',
      toolCalls: [
        { name: 'read', arguments: { path: 'src/forecast.js' } },
        { name: 'shell', arguments: { command: 'node test.js', title: 'Run the tests' } }
      ]
    },
    {
      waitMs: 400,
      text: '`formatTemperature` always converts to Fahrenheit and never reads `unit`. Fixing it:',
      toolCalls: [
        {
          name: 'edit',
          arguments: {
            file_path: 'src/forecast.js',
            old_string: FORECAST_BUG,
            new_string: FORECAST_FIX
          }
        }
      ]
    },
    {
      waitMs: 300,
      toolCalls: [
        { name: 'shell', arguments: { command: 'node test.js', title: 'Run the tests again' } }
      ]
    },
    {
      waitMs: 300,
      text: 'Fixed. **`formatTemperature`** now returns Celsius when the unit is `C` and only converts for `F`, so the forecast card follows the setting.\n\n- Both Celsius cases failed before the fix\n- **All 3 tests pass** now'
    }
  ],
  'forecast for the station': [
    {
      waitMs: 400,
      text: 'Here is the station forecast, built from its log.',
      toolCalls: [
        {
          name: 'create_artifact',
          arguments: { type: 'react', title: 'Station forecast', code: FORECAST },
          chunk: 22,
          delayMs: 22
        }
      ]
    },
    {
      waitMs: 300,
      text: 'Wednesday peaks at **24°C**; rain moves through on Thursday and Friday.'
    }
  ],
  'evening sky': [
    {
      waitMs: 400,
      toolCalls: [
        {
          name: 'edit_artifact',
          arguments: { title: 'Station forecast', edits: EVENING_EDITS },
          chunk: 30,
          delayMs: 18
        }
      ]
    },
    { waitMs: 200, text: 'Switched to the evening sky: 17°C and clear after sunset.' }
  ],
  'Split the follow-ups': [
    {
      waitMs: 400,
      text: 'Two separate pieces of work, so each gets its own chat and worktree:',
      toolCalls: [
        {
          name: 'start_session',
          arguments: {
            mode: 'start',
            sessions: [
              {
                title: 'Test negative readings',
                handle: 'tests',
                brief: 'Add a test that a negative Celsius reading formats as -4°C.',
                work_in: 'worktree'
              },
              {
                title: 'Document the unit setting',
                handle: 'docs',
                brief: 'Document the Celsius and Fahrenheit setting in the README.',
                work_in: 'worktree'
              }
            ]
          }
        }
      ]
    },
    { waitMs: 200, text: 'Both chats are working; they report back here when they finish.' }
  ],
  'negative Celsius reading formats': [
    {
      waitMs: 1200,
      thinking: 'test.js already covers -4 °C; check it and confirm it passes.',
      toolCalls: [{ name: 'read', arguments: { path: 'test.js' } }]
    },
    { waitMs: 600, text: 'Added a regression test for negative Celsius readings; all tests pass.' }
  ],
  'Document the Celsius and Fahrenheit': [
    { waitMs: 2200, toolCalls: [{ name: 'read', arguments: { path: 'README.md' } }] },
    { waitMs: 600, text: 'The README now documents the unit setting and its default.' }
  ],
  'regression test for negative': [
    { waitMs: 300, text: '**Tests** finished: negative readings are covered.' }
  ],
  'documents the unit setting and': [
    { waitMs: 300, text: '**Docs** finished too, so both follow-ups are done.' }
  ]
}
