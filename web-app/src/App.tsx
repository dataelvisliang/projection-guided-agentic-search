import { useState, useEffect, useRef, useCallback } from 'react';
import { coordinator, wasmConnector, Coordinator } from '@uwdata/mosaic-core';
import { EmbeddingAtlas } from '@dataelvisliang/embedding-atlas/react';
import { MessageCircle, X, Send, Square, Trash2, Database, Search, BarChart3, Download } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgentChat } from './hooks/useAgentChat';
import './App.css';

// Initialize coordinator globally
const c = coordinator();


function App() {
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [input, setInput] = useState('');
  const [dataLoaded, setDataLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPoints, setSelectedPoints] = useState<any[]>([]);
  const [selectionPredicate, setSelectionPredicate] = useState<string | null>(null);
  const [coordinatorReady, setCoordinatorReady] = useState<Coordinator | null>(null);

  // Resizable chat window state
  const [chatSize, setChatSize] = useState({ width: 550, height: 650 });
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{ startX: number; startY: number; startWidth: number; startHeight: number } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Use the agent chat hook
  const {
    messages,
    isLoading,
    currentStep,
    toolsExecuted,
    searchPolicy,
    highlightIds,
    savedCategories,
    sendMessage,
    clearChat,
    clearHighlight,
    stopGeneration
  } = useAgentChat(coordinatorReady);

  // Fetch selected points when predicate changes
  useEffect(() => {
    async function fetchSelectedPoints() {
      if (!selectionPredicate || !coordinatorReady) {
        setSelectedPoints([]);
        return;
      }

      try {
        console.log("[Selection] Predicate changed:", selectionPredicate);

        // First get the total count of selected points
        const countQuery = `SELECT COUNT(*) as total FROM reviews WHERE ${selectionPredicate}`;
        const countResult = await coordinatorReady.query(countQuery);
        const totalCount = countResult.toArray()[0]?.total || 0;
        console.log("[Selection] Total selected:", totalCount);

        // Fetch more reviews - we'll truncate based on token limit in useAgentChat
        const query = `SELECT __row_index__ as identifier, points, title, price, description FROM reviews WHERE ${selectionPredicate} LIMIT 500`;
        console.log("[Selection] Querying sample:", query);

        const result = await coordinatorReady.query(query);
        const rows = result.toArray();
        console.log("[Selection] Got", rows.length, "sample points");

        // Transform to match expected format
        const points = rows.map((r: any) => ({
          identifier: r.identifier,
          text: r.description,
          fields: {
            points: r.points,
            title: r.title,
            price: r.price,
            description: r.description
          }
        }));

        // Attach totalCount as array property for access
        const pointsWithCount = Object.assign(points, { totalCount });
        setSelectedPoints(pointsWithCount);
      } catch (err) {
        console.error("[Selection] Failed to fetch selected points:", err);
        setSelectedPoints([]);
      }
    }

    fetchSelectedPoints();
  }, [selectionPredicate, coordinatorReady]);

  // Scroll state
  const [shouldAutoScroll, setShouldAutoScroll] = useState(false);

  // Auto-scroll logic: Only scroll when manually triggered (e.g. new user message)
  // or when initially loading
  useEffect(() => {
    if (shouldAutoScroll) {
       messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
       setShouldAutoScroll(false);
    }
  }, [messages, shouldAutoScroll]);

  useEffect(() => {
    async function init() {
      try {
        console.log("Initializing Mosaic Coordinator...");
        const connector = await wasmConnector();
        c.databaseConnector(connector);

        const baseUrl = import.meta.env.BASE_URL.endsWith('/')
          ? import.meta.env.BASE_URL
          : import.meta.env.BASE_URL + '/';

        const dataUrl = new URL(`${baseUrl}atlas/data/dataset.parquet`, window.location.origin).href;

        console.log("Loading parquet data from:", dataUrl);
        await c.exec(`
          CREATE OR REPLACE TABLE reviews AS
          SELECT * FROM read_parquet('${dataUrl}')
        `);

        console.log("Parquet loaded successfully.");
        setDataLoaded(true);
        setCoordinatorReady(c as unknown as Coordinator);
      } catch (e: any) {
        console.error("Initialization failed:", e);
        setError(e.message || String(e));
      }
    }
    init();
  }, []);

  // Resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: chatSize.width,
      startHeight: chatSize.height
    };
  }, [chatSize]);

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!isResizing || !resizeRef.current) return;

    // Since window is anchored at bottom-right, dragging left increases width
    const deltaX = resizeRef.current.startX - e.clientX;
    const deltaY = resizeRef.current.startY - e.clientY;

    const newWidth = Math.max(320, Math.min(800, resizeRef.current.startWidth + deltaX));
    const newHeight = Math.max(400, Math.min(window.innerHeight * 0.9, resizeRef.current.startHeight + deltaY));

    setChatSize({ width: newWidth, height: newHeight });
  }, [isResizing]);

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
    resizeRef.current = null;
  }, []);

  // Attach global mouse events for resize
  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleResizeMove);
      document.addEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';
    }
    return () => {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, handleResizeMove, handleResizeEnd]);

    const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    const userMessage = input.trim();
    setInput('');
    setShouldAutoScroll(true); // Scroll to bottom when user sends message
    // Pass both selectedPoints and the predicate for tool queries
    await sendMessage(userMessage, selectedPoints, selectionPredicate);
  };

  const handleDownloadChat = () => {
    let mdContent = messages.map(m => {
      const role = m.role === 'user' ? '**User**' : '**AI Sommelier**';
      
      // Expand {{Category}} placeholders with actual review data
      let content = m.content;
      const categoryPattern = /\{\{([^}]+)\}\}/g;
      content = content.replace(categoryPattern, (match, categoryName) => {
        const categoryData = savedCategories.get(categoryName) as any[] | undefined;
        const data = categoryData?.[0];
        if (!data?.reviews) {
          return match; // Keep original if no data found
        }
        
        // Format reviews as markdown table
        const reviews = data.reviews as any[];
        let table = `\n\n**${categoryName}** (${reviews.length} wines)\n\n`;
        table += `| Wine | Points | Price | Description |\n`;
        table += `|------|--------|-------|-------------|\n`;
        
        for (const review of reviews) {
          const title = (review.title || 'Unknown').replace(/\|/g, '\\|');
          const points = review.points || '-';
          const price = review.price ? `$${review.price}` : '-';
          const desc = (review.text || review.description || '').slice(0, 100).replace(/\|/g, '\\|').replace(/\n/g, ' ');
          table += `| ${title} | ${points} | ${price} | ${desc}... |\n`;
        }
        
        return table;
      });
      
      return `${role}:\n${content}\n\n---\n`;
    }).join('\n');

    if (searchPolicy) {
      const benchmarkExport = {
        ...searchPolicy,
        saved_categories: Object.fromEntries(savedCategories)
      };
      mdContent += `\n\n## Search policy trajectory\n\n\`\`\`json\n${JSON.stringify(benchmarkExport, null, 2)}\n\`\`\`\n`;
    }
    
    const blob = new Blob([mdContent], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sommelier-chat-${new Date().toISOString().slice(0,10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Tool icon mapping
  const getToolIcon = (toolName: string) => {
    switch (toolName) {
      case 'map_search':
      case 'flexible_search': return <Search size={12} />;
      case 'sql_query':
      case 'load_workflow_playbook': return <Database size={12} />;
      case 'compare_regions': return <BarChart3 size={12} />;
      case 'save_selection': return <Download size={12} />;
      default: return <Database size={12} />;
    }
  };

  return (
    <div className="app-container">
      <div className="atlas-container">
        {error ? (
          <div className="loading-screen" style={{ color: '#ef4444' }}>
            <p>Error loading Atlas:</p>
            <pre>{error}</pre>
          </div>
        ) : dataLoaded ? (
          <EmbeddingAtlas
            coordinator={c}
            data={{
              table: "reviews",
              id: "__row_index__",
              text: "description",
              projection: { x: "projection_x", y: "projection_y" },
              neighbors: "neighbors"
            }}
            embeddingViewConfig={{
              pointSize: 3,
            }}
            defaultChartsConfig={{
              table: false
            }}
            highlight={highlightIds}
            initialState={{ version: "0.0.0", timestamp: Date.now() }}
            onStateChange={(state) => {
              // Only update if predicate actually changed to avoid re-render spam
              const newPredicate = state.predicate || null;
              setSelectionPredicate(prev => {
                if (prev !== newPredicate) {
                  console.log("[Atlas] Predicate changed:", newPredicate);
                  return newPredicate;
                }
                return prev;
              });
            }}
          />
        ) : (
          <div className="loading-screen">
            <div className="spinner"></div>
            <p>Initializing Native Atlas...</p>
          </div>
        )}
      </div>

      <div className={`chat-widget ${isChatOpen ? 'open' : ''}`}>
        {!isChatOpen && (
          <button className={`chat-fab ${isLoading ? 'loading' : ''}`} onClick={() => setIsChatOpen(true)}>
            <MessageCircle size={24} />
            <span>Atlas Agent</span>
            {selectedPoints.length > 0 && (
              <span className="selection-badge">{(selectedPoints as any).totalCount || selectedPoints.length}</span>
            )}
          </button>
        )}

        {isChatOpen && (
          <div
            className="chat-window"
            style={{
              width: `${chatSize.width}px`,
              height: `${chatSize.height}px`,
              maxHeight: '90vh'
            }}
          >
            {/* Resize handle */}
            <div
              className="resize-handle"
              onMouseDown={handleResizeStart}
              title="Drag to resize"
            />
            <div className="chat-header">
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <h3>
                  <Database size={16} style={{ marginRight: '6px', opacity: 0.7 }} />
                  Atlas Agent
                </h3>
                {selectedPoints.length > 0 && (
                  <span style={{ fontSize: '10px', color: '#60a5fa', fontWeight: 'normal' }}>
                    {(selectedPoints as any).totalCount || selectedPoints.length} items selected on map
                  </span>
                )}
                {highlightIds && highlightIds.length > 0 && (
                  <span
                    style={{
                      fontSize: '10px',
                      color: '#f97316',
                      fontWeight: 'normal',
                      cursor: 'pointer',
                      textDecoration: 'underline'
                    }}
                    onClick={clearHighlight}
                    title="Click to clear highlight"
                  >
                    {highlightIds.length} points highlighted (click to clear)
                  </span>
                )}
              </div>
              <div className="header-actions">
                <button onClick={handleDownloadChat} title="Download chat history">
                  <Download size={16} />
                </button>
                <button onClick={clearChat} title="Clear chat">
                  <Trash2 size={16} />
                </button>
                <button onClick={() => setIsChatOpen(false)}>
                  <X size={20} />
                </button>
              </div>
            </div>

            <div className="chat-messages">
              {messages.map((msg, i) => (
                <div key={i} className={`message ${msg.role}`}>
                  <div className="message-content">
                    {msg.role === 'assistant' ? (
                      <>
                        {/* Process content to replace {{CATEGORY}} placeholders */}
                        {(() => {
                          const content = msg.content;
                          // Match {{anything}} - use [^}]+ to capture everything except closing braces
                          const categoryRegex = /\{\{([^}]+)\}\}/g;
                          const parts: React.ReactNode[] = [];
                          let lastIndex = 0;
                          let match;

                          while ((match = categoryRegex.exec(content)) !== null) {
                            // Add text before the match
                            if (match.index > lastIndex) {
                              parts.push(
                                <ReactMarkdown key={`text-${lastIndex}`} remarkPlugins={[remarkGfm]}>
                                  {content.slice(lastIndex, match.index)}
                                </ReactMarkdown>
                              );
                            }

                            // Add category card for the match
                            const categoryKey = match[1];
                            console.log('[UI] Found category placeholder:', categoryKey);
                            console.log('[UI] savedCategories Map:', savedCategories);
                            const categoryData = savedCategories?.get(categoryKey);
                            console.log('[UI] Category data for', categoryKey, ':', categoryData);

                            if (categoryData && categoryData.length > 0) {
                              const data = categoryData[0]; // Get first entry
                              const reviews = data.reviews || [];
                              
                              parts.push(
                                <div key={`category-${match.index}`} style={{
                                  margin: '12px 0',
                                  padding: '16px',
                                  background: 'rgba(59, 130, 246, 0.05)',
                                  border: '1px solid rgba(59, 130, 246, 0.3)',
                                  borderRadius: '8px'
                                }}>
                                  <div style={{ fontWeight: 'bold', marginBottom: '12px', color: '#60a5fa', fontSize: '16px' }}>
                                    📦 {data.category || categoryKey}
                                  </div>
                                  <div style={{ fontSize: '12px', opacity: 0.7, marginBottom: '12px' }}>
                                    <span style={{ marginRight: '12px' }}>Sentiment: {data.sentiment}</span>
                                    <span style={{ marginRight: '12px' }}>Avg Points: {data.avg_points || data.avg_rating}</span>
                                    <span>Samples: {reviews.length}</span>
                                  </div>
                                  {(typeof data.purity === 'number' || typeof data.intent_match === 'number') && (
                                    <div style={{ fontSize: '12px', opacity: 0.8, marginBottom: '12px' }}>
                                      <span style={{ marginRight: '12px' }}>Purity: {typeof data.purity === 'number' ? `${Math.round(data.purity * 100)}%` : 'N/A'}</span>
                                      <span>Intent match: {typeof data.intent_match === 'number' ? `${Math.round(data.intent_match * 100)}%` : 'N/A'}</span>
                                    </div>
                                  )}
                                  {data.themes && data.themes.length > 0 && (
                                    <div style={{ fontSize: '13px', marginBottom: '12px', opacity: 0.8 }}>
                                      <strong>Themes:</strong> {data.themes.join(', ')}
                                    </div>
                                  )}
                                  
                                  {/* Display all review samples */}
                                  {reviews.length > 0 && (
                                    <div style={{ marginTop: '12px' }}>
                                      <strong style={{ fontSize: '13px', opacity: 0.9 }}>Sample Reviews:</strong>
                                      <div style={{ maxHeight: '400px', overflowY: 'auto', marginTop: '8px' }}>
                                        {reviews.map((review: any, idx: number) => (
                                          <div key={idx} style={{
                                            padding: '10px',
                                            marginBottom: '8px',
                                            background: 'rgba(255, 255, 255, 0.05)',
                                            borderLeft: '3px solid rgba(59, 130, 246, 0.5)',
                                            borderRadius: '4px',
                                            fontSize: '12px'
                                          }}>
                                            <div style={{ fontWeight: 'bold', marginBottom: '4px', opacity: 0.6 }}>
                                              {review.title ? <span style={{display: 'block', marginBottom: '4px'}}>{review.title}</span> : null}
                                              Review #{idx + 1} - Points: {review.points || review.rating || review.Rating}
                                            </div>
                                            <div style={{ opacity: 0.85, lineHeight: '1.5' }}>
                                              {review.text || review.description || review.excerpt}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            } else {
                              // Fallback if category not found
                              parts.push(
                                <span key={`missing-${match.index}`} style={{ color: '#f97316' }}>
                                  [Category: {categoryKey}]
                                </span>
                              );
                            }

                            lastIndex = categoryRegex.lastIndex;
                          }

                          // Add remaining text
                          if (lastIndex < content.length) {
                            parts.push(
                              <ReactMarkdown key={`text-${lastIndex}`} remarkPlugins={[remarkGfm]}>
                                {content.slice(lastIndex)}
                              </ReactMarkdown>
                            );
                          }

                          return parts.length > 0 ? parts : (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                          );
                        })()}
                      </>
                    ) : (
                      msg.content
                    )}
                  </div>
                  {msg.toolResults && msg.toolResults.length > 0 && (
                    <div className="tools-used">
                      {msg.toolResults.map((t, k) => (
                        <span key={k} className="tool-badge">
                          {getToolIcon(t.name)}
                          {t.name.replace('_', ' ')}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {/* Loading indicator with tool status - only show if we have a status message */}
              {isLoading && currentStep && (
                <div className="message assistant loading">
                  <div className="typing-indicator">
                    <span></span><span></span><span></span>
                  </div>
                  {currentStep && (
                    <div className="step-indicator">{currentStep}</div>
                  )}
                  {toolsExecuted.length > 0 && (
                    <div className="tools-executing">
                      {toolsExecuted.map((tool, i) => (
                        <span key={i} className="tool-badge executing">
                          {getToolIcon(tool)}
                          {tool.replace('_', ' ')}
                        </span>
                      ))}
                    </div>
                  )}
                  {searchPolicy && (
                    <div className="step-indicator" style={{ marginTop: '6px' }}>
                      Policy: {searchPolicy.inspected_region_count} probes | {searchPolicy.accepted_region_count}/{searchPolicy.objective.target_accepted_regions} accepted | {searchPolicy.relevant_themes.length} relevant themes | {searchPolicy.frontier.length} frontier | {searchPolicy.remaining.toolCalls} actions | {searchPolicy.remaining.modelTokens.toLocaleString()} tokens left | {(searchPolicy.elapsed_ms / 1000).toFixed(1)}s
                      {searchPolicy.must_stop && ` | stopping: ${searchPolicy.stop_reason}`}
                    </div>
                  )}
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            <div className="chat-input-area">
              <textarea
                placeholder={isLoading ? "Analyzing..." : "Ask about wines, flavors, prices... (Shift+Enter for new line)"}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  // Auto-resize textarea
                  e.target.style.height = 'auto';
                  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !isLoading) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                disabled={isLoading}
                rows={1}
              />
              <button
                className={isLoading ? 'loading' : ''}
                onClick={isLoading ? stopGeneration : handleSend}
              >
                {isLoading ? <Square size={12} fill="currentColor" /> : <Send size={12} />}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
