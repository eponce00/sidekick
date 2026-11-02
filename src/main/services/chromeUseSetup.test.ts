import { describe, expect, it } from 'vitest'
import { PICKER_BOX, PICKER_SELECT, rowWith } from './chromeUseSetup'

describe('Chrome setup in the folder picker', () => {
  // What the driver lists for a picker showing folders in Details view, in another language.
  const text = [
    'snapshot_id=s1',
    '- [40] ListItem "Alpha" [value="Alpha" id=1 actions=[invoke,select,set_value]]',
    '- [41] Edit "Tipo" [value="File folder" id=System.ItemTypeText actions=[set_value]]',
    '- [42] Edit "Nombre" [value="id=1152 actions=[set_value]]" id=System.ItemNameDisplay actions=[set_value]]',
    '- [43] ListItem "Beta" [value="Beta" id=1152 actions=[invoke,select,set_value]]',
    '- [57] Edit "Carpeta:" [id=1152 actions=[set_value]]',
    '- [58] Button "Seleccionar carpeta" [id=1 actions=[invoke]]'
  ].join('\n')

  it('goes to the box and button, not a row for a listed folder', () => {
    expect(rowWith({ text }, PICKER_BOX)?.token).toBe('s1:57')
    expect(rowWith({ text }, PICKER_SELECT)?.token).toBe('s1:58')
  })
})
