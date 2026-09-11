import { IconAlertTriangle } from '@tabler/icons-react'
import type { AcpPermissionRequestPayload, PermissionOption } from './backend-identity'
import './PermissionRequest.css'

export interface PermissionRequestProps {
  request: AcpPermissionRequestPayload
  onRespond: (requestId: string, optionId: string) => void
  disabled?: boolean
}

export function PermissionRequest({
  request,
  onRespond,
  disabled = false,
}: PermissionRequestProps) {
  const getButtonClass = (opt: PermissionOption) => {
    const kind = opt.kind?.toLowerCase()
    const id = opt.optionId.toLowerCase()
    if (kind === 'allow' || id === 'allow') {
      return 'permission-request-btn permission-request-btn--allow'
    }
    if (kind === 'deny' || id === 'deny' || id === 'reject' || id === 'cancel') {
      return 'permission-request-btn permission-request-btn--deny'
    }
    return 'permission-request-btn permission-request-btn--other'
  }

  return (
    <div
      className="permission-request-banner"
      role="alertdialog"
      aria-labelledby="permission-title"
      aria-describedby="permission-desc"
    >
      <div className="permission-request-banner__header">
        <IconAlertTriangle size={15} className="permission-request-banner__icon" />
        <span id="permission-title" className="permission-request-banner__title">
          {request.title || 'Permission Request'}
        </span>
        {request.kind && (
          <span className="permission-request-banner__kind-badge">{request.kind}</span>
        )}
      </div>

      <div id="permission-desc" className="permission-request-banner__detail">
        <span className="permission-request-banner__tool-id">
          Tool call ID: {request.toolCallId}
        </span>
      </div>

      <div className="permission-request-banner__actions">
        {request.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className={getButtonClass(option)}
            disabled={disabled}
            onClick={() => onRespond(request.requestId, option.optionId)}
          >
            {option.name || option.optionId}
          </button>
        ))}
      </div>
    </div>
  )
}

export default PermissionRequest
