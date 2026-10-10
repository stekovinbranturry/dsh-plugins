/** 可搜索的分支下拉：分支多起来以后需要打几个字就筛出来，所以不用原生 select。 */
import { useState } from 'react'
import type { ReactElement } from 'react'

import type { BranchItem } from '../shared/types.js'
import { filterBranches, isPickable, stepUsable } from './branches.js'
import { IconCheck } from './icons.js'

interface ComboProps {
  items: readonly BranchItem[]
  value: string
  placeholder: string
  ariaLabel: string
  /** 哪些项能选；默认"已被检出的不能当目标" */
  pickable?: (branch: BranchItem) => boolean
  onPick: (branch: BranchItem) => void
}

/**
 * 可搜索的分支下拉。分支多起来以后需要打几个字就筛出来，所以不用原生 select。
 *
 * 自己持有"输入中/展开/光标"三个状态，value 由调用方控制：目标分支和起点两处共用一套。
 */
export function BranchCombo({
  items,
  value,
  placeholder,
  ariaLabel,
  pickable = isPickable,
  onPick,
}: ComboProps): ReactElement {
  const [query, setQuery] = useState('')
  const [listOpen, setListOpen] = useState(false)
  /** 键盘光标：-1 表示还没有导航过，打开时第一项不带高亮，只有悬停或按方向键才出现 */
  const [active, setActive] = useState(-1)
  const matches = filterBranches(items, query)

  const pick = (item: BranchItem): void => {
    if (!pickable(item)) return
    setQuery('')
    setListOpen(false)
    setActive(-1)
    onPick(item)
  }

  return (
    <div className="wt-combo">
      <input
        className="wt-input wt-combo-input"
        value={listOpen ? query : value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        aria-expanded={listOpen}
        role="combobox"
        onFocus={() => {
          setListOpen(true)
          setQuery('')
          setActive(-1)
        }}
        onChange={(event) => {
          const next = event.target.value
          setQuery(next)
          setListOpen(true)
          setActive(-1)
        }}
        onBlur={() => setListOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setListOpen(false)
            return
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setListOpen(true)
            const delta = event.key === 'ArrowDown' ? 1 : -1
            setActive((previous) => stepUsable(matches, previous, delta, pickable))
            return
          }
          if (event.key === 'Enter') {
            const item = matches[active]
            if (item !== undefined && pickable(item)) {
              event.preventDefault()
              pick(item)
            }
          }
        }}
      />
      {listOpen ? (
        <div className="wt-combo-list" role="listbox" aria-label={ariaLabel + '列表'}>
          {matches.length === 0 ? (
            <div className="wt-combo-empty">没有匹配的分支</div>
          ) : (
            matches.map((item, index) => (
              <button
                key={item.name}
                type="button"
                role="option"
                aria-selected={item.name === value}
                disabled={!pickable(item)}
                className={'wt-combo-item' + (index === active ? ' wt-combo-item-active' : '')}
                // mousedown 早于 blur：先 preventDefault 才不会让输入框失焦，
                // 否则下拉会在点中之前就被 onBlur 关掉
                onMouseDown={(event) => {
                  event.preventDefault()
                  pick(item)
                }}
              >
                <span className="wt-combo-name">{item.name}</span>
                {item.kind === 'remote' ? <span className="wt-combo-tag">远端</span> : null}
                {item.inWorktree === null ? null : <span className="wt-combo-tag">已被检出</span>}
                {item.name === value ? (
                  <span className="wt-combo-check">
                    <IconCheck />
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
