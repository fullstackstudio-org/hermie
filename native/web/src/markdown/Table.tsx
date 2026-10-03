/**
 * A table: its own scrolling container, a real `table` inside it.
 *
 * The container is focusable so a keyboard can scroll a table wider than the
 * column (a pointer-less reader has no other way to reach the right-hand
 * cells). The header cells carry `scope="col"`, so a screen reader announces
 * the column title with each cell.
 */
import type { Token, Tokens } from '@hermie/markdown/marked-compat'

import { Inline } from './Inline'

export interface TableProps {
  token: Tokens.Table
  baseUrl: string | undefined
}

function alignClass(align: Tokens.TableCell['align']): string | undefined {
  return align === 'center' || align === 'right' ? `md-align-${align}` : undefined
}

export function Table({ token, baseUrl }: TableProps) {
  return (
    <div className="md-table-scroll" tabIndex={0}>
      <table>
        <thead>
          <tr>
            {token.header.map((cell, index) => (
              <th className={alignClass(cell.align)} key={index} scope="col">
                <Inline baseUrl={baseUrl} tokens={cell.tokens as Token[]} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {token.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td className={alignClass(cell.align)} key={cellIndex}>
                  <Inline baseUrl={baseUrl} tokens={cell.tokens as Token[]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
