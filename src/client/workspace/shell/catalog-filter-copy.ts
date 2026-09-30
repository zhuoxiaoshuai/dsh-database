export type CatalogFilterCopy = {
  noun: string
  title: string
  ariaLabel: string
  hint: string
  searchLabel: string
  clearSearchLabel: string
  emptyMatch: string
  emptyList: string
  groupLabel: string
  emptyTree: string
}

/** MySQL/Oracle 既有文案，不从名词拼出来。 */
export const sqlCatalogFilterCopy: CatalogFilterCopy = {
  noun: '数据库',
  title: '显示的数据库',
  ariaLabel: '配置显示的数据库',
  hint: '勾选要在对象树中显示的数据库；不勾选任何库时显示全部，当前打开的库始终显示。',
  searchLabel: '搜索数据库',
  clearSearchLabel: '清空数据库搜索',
  emptyMatch: '没有匹配的数据库。',
  emptyList: '连接在线并加载对象树后，才能选择要显示的数据库。',
  groupLabel: '数据库多选',
  emptyTree: '没有可见的数据库',
}

export function catalogFilterCopy(noun: string): CatalogFilterCopy {
  return {
    noun,
    title: `显示的${noun}`,
    ariaLabel: `配置显示的${noun}`,
    hint: `勾选要在对象树中显示的${noun}；不勾选任何项时显示全部，当前选中项始终显示。`,
    searchLabel: `搜索${noun}`,
    clearSearchLabel: `清空${noun}搜索`,
    emptyMatch: `没有匹配的${noun}。`,
    emptyList: `连接在线并加载对象树后，才能选择要显示的${noun}。`,
    groupLabel: `${noun}多选`,
    emptyTree: `没有可见的${noun}`,
  }
}
