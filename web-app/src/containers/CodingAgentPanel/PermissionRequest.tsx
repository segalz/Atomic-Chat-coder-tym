import { useState } from 'react'
import { IconAlertTriangle, IconTerminal, IconFileCode } from '@tabler/icons-react'
import type { AcpPermissionRequestPayload, PermissionOption } from './backend-identity'
import {
  extractPermissionCommand,
  extractPermissionFileEdit,
} from './backend-identity'
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
  const [submittingOptionId, setSubmittingOptionId] = useState<string | null>(null)
  const command = extractPermissionCommand(request)
  const fileEdit = extractPermissionFileEdit(request)

  const isActionsDisabled = disabled || submittingOptionId !== null

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

  const handleActionClick = (optionId: string) => {
    if (isActionsDisabled) return
    setSubmittingOptionId(optionId)
    onRespond(request.requestId, optionId)
  }

  return (
    <div
      className="permission-request-banner"
      role="alertdialog"
      aria-labelledby="permission-title"
      aria-describedby="permission-desc"
    >
      <div className="permission-request-banner__header">
        {command ? (
          <IconTerminal
            size={15}
            className="permission-request-banner__icon permission-request-banner__icon--command"
          />
        ) : fileEdit ? (
          <IconFileCode
            size={15}
            className="permission-request-banner__icon permission-request-banner__icon--edit"
          />
        ) : (
          <IconAlertTriangle size={15} className="permission-request-banner__icon" />
        )}
        <span id="permission-title" className="permission-request-banner__title">
          {request.title ||
            (command ? 'Command Execution' : fileEdit ? 'Proposed File Edit' : 'Permission Request')}
        </span>
        {request.kind && (
          <span className="permission-request-banner__kind-badge">{request.kind}</span>
        )}
        {fileEdit ? (
          <span className="permission-request-banner__status-badge proposed">
            Proposed (Not applied)
          </span>
        ) : command ? (
          <span className="permission-request-banner__status-badge pending">
            Pending Approval
          </span>
        ) : null}
      </div>

      <div id="permission-desc" className="permission-request-banner__detail">
        {command ? (
          <div className="permission-request-banner__command-box">
            <div className="permission-request-banner__command-header">Command to execute:</div>
            <pre className="permission-request-banner__code-block">
              <code>{command}</code>
            </pre>
          </div>
        ) : fileEdit ? (
          <div className="permission-request-banner__edit-box">
            <div className="permission-request-banner__file-row">
              <span className="permission-request-banner__file-label">Target file:</span>
              <span className="permission-request-banner__file-path" title={fileEdit.path}>
                {fileEdit.path}
              </span>
              {fileEdit.line !== undefined ? (
                <span className="permission-request-banner__line-badge">Line {fileEdit.line}</span>
              ) : fileEdit.startLine !== undefined && fileEdit.endLine !== undefined ? (
                <span className="permission-request-banner__line-badge">
                  L{fileEdit.startLine}–L{fileEdit.endLine}
                </span>
              ) : null}
            </div>
            {fileEdit.search && fileEdit.replace ? (
              <div className="permission-request-banner__search-replace">
                <div className="permission-request-banner__diff-chunk diff-del">
                  -{fileEdit.search}
                </div>
                <div className="permission-request-banner__diff-chunk diff-add">
                  +{fileEdit.replace}
                </div>
              </div>
            ) : fileEdit.diff ? (
              <pre className="permission-request-banner__diff-block">
                <code>{fileEdit.diff}</code>
              </pre>
            ) : null}
          </div>
        ) : (
          <span className="permission-request-banner__tool-id">
            Tool call ID: {request.toolCallId}
          </span>
        )}
      </div>

      <div className="permission-request-banner__actions">
        {request.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className={getButtonClass(option)}
            disabled={isActionsDisabled}
            onClick={() => handleActionClick(option.optionId)}
          >
            {option.name || option.optionId}
          </button>
        ))}
      </div>
    </div>
  )
}

export default PermissionRequest
