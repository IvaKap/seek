/*
 * Seek — the crash guard.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * There was none. React unmounts the whole tree when a render throws, so one
 * malformed payload reaching one component left a blank window until relaunch
 * — while the engine kept downloading behind it, invisible. Now a pane that
 * fails says so, keeps the sidebar working, and can be tried again.
 *
 * A class because error boundaries still have no hook form.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { copyText } from '../data/clipboard.ts';

interface Props {
  children: ReactNode;
  /** Where this boundary sits, for the message and the copied details. */
  label: string;
}

interface State {
  error: Error | null;
  stack: string;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '', copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, copied: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept for the devtools console; nothing leaves the machine.
    console.error(`[seek] ${this.props.label} crashed`, error, info.componentStack);
    this.setState({ stack: info.componentStack ?? '' });
  }

  private reset = () => this.setState({ error: null, stack: '', copied: false });

  private copy = () => {
    const { error, stack } = this.state;
    const text = `${this.props.label}: ${error?.name}: ${error?.message}\n${error?.stack ?? ''}\n${stack}`;
    void copyText(text).then((ok) => this.setState({ copied: ok }));
  };

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="pane__scroll">
        <div className="empty empty--section" role="alert">
          <p className="empty__title">This screen hit a problem</p>
          <p className="empty__body">
            Seek is still running — downloads carry on, and the rest of the app
            works. Try again, or copy the details for a bug report.
          </p>
          <p className="empty__body crash__detail">{error.message}</p>
          <div className="crash__actions">
            <button type="button" className="btn btn--primary pressable" onClick={this.reset}>
              Try again
            </button>
            <button type="button" className="btn pressable" onClick={this.copy}>
              {copied ? 'Copied' : 'Copy details'}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
