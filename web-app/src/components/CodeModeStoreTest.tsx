import { useCodeModeStore } from '@/stores/code-mode-store'

/**
 * Temporary test component to verify Zustand store functionality
 * Remove this component after verifying state updates work correctly
 */
export function CodeModeStoreTest() {
  const {
    mode,
    projectDir,
    draftPrompt,
    permissionMode,
    isAgentRunning,
    agentOutput,
    setMode,
    setProjectDir,
    setDraftPrompt,
    setPermissionMode,
    setAgentRunning,
    appendOutput,
    clearOutput,
  } = useCodeModeStore()

  return (
    <div style={{ padding: '20px', border: '2px solid blue', margin: '10px' }}>
      <h2>Code Mode Store Test</h2>

      <div>
        <h3>Persistent State:</h3>
        <p>
          <strong>Mode:</strong> {mode}{' '}
          <button onClick={() => setMode(mode === 'chat' ? 'code' : 'chat')}>
            Toggle
          </button>
        </p>
        <p>
          <strong>Project Dir:</strong> {projectDir || '(empty)'}
          <input
            type="text"
            value={projectDir}
            onChange={(e) => setProjectDir(e.target.value)}
            placeholder="Enter project directory"
            style={{ marginLeft: '10px', padding: '5px' }}
          />
        </p>
        <p>
          <strong>Draft Prompt:</strong> {draftPrompt || '(empty)'}
          <textarea
            value={draftPrompt}
            onChange={(e) => setDraftPrompt(e.target.value)}
            placeholder="Enter draft prompt"
            style={{ marginLeft: '10px', padding: '5px', width: '300px' }}
          />
        </p>
        <p>
          <strong>Permission Mode:</strong> {permissionMode}{' '}
          <button
            onClick={() =>
              setPermissionMode(
                permissionMode === 'ask' ? 'auto_accept' : 'ask'
              )
            }
          >
            Toggle
          </button>
        </p>
      </div>

      <div>
        <h3>Runtime State:</h3>
        <p>
          <strong>Is Agent Running:</strong> {isAgentRunning ? 'Yes' : 'No'}{' '}
          <button onClick={() => setAgentRunning(!isAgentRunning)}>
            Toggle
          </button>
        </p>
        <p>
          <strong>Agent Output Lines:</strong> {agentOutput.length}
          <button
            onClick={() => {
              appendOutput({
                type: 'system',
                content: `Test output ${Date.now()}`,
                timestamp: Date.now(),
              })
            }}
            style={{ marginLeft: '10px' }}
          >
            Add Line
          </button>
          <button onClick={clearOutput} style={{ marginLeft: '10px' }}>
            Clear
          </button>
        </p>
        <div
          style={{
            maxHeight: '200px',
            overflow: 'auto',
            border: '1px solid #ccc',
            padding: '10px',
            marginTop: '10px',
          }}
        >
          {agentOutput.map((line, idx) => (
            <div key={idx} style={{ fontSize: '12px', marginBottom: '5px' }}>
              <strong>[{line.type}]</strong> {line.content}
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: '20px', fontSize: '12px', color: '#666' }}>
        <p>
          ✓ This is a temporary test component. You can remove it after
          verifying state changes work correctly.
        </p>
        <p>Check React DevTools to see persisted state in localStorage.</p>
      </div>
    </div>
  )
}
