import type { ComponentPropsWithRef, ReactElement } from 'react'

import './primitives.css'

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  /** `primary` is the tint's fill; `quiet` is an outline in the tint's ink. */
  variant?: 'primary' | 'quiet'
}

/** A button. Always `type="button"` unless told otherwise: nothing in the client submits a form. */
export function Button({ variant = 'primary', type = 'button', className, ...rest }: ButtonProps): ReactElement {
  return (
    <button
      {...rest}
      type={type}
      data-variant={variant}
      className={className ? `hm-button ${className}` : 'hm-button'}
    />
  )
}
