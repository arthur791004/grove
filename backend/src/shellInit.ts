import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let cachedDir: string | null = null;

const ZSHRC = `# Grove zsh init — sources user config then installs block hooks

# Disable prompt-theme niceties that don't fit our UI BEFORE user zshrc runs
typeset -g POWERLEVEL9K_INSTANT_PROMPT=off
typeset -g STARSHIP_DISABLE_TRANSIENT=1
unset POWERLEVEL10K_DISABLE_GITSTATUS 2>/dev/null

# When ZDOTDIR is set, zsh stops loading the user's own ~/.zshenv, ~/.zprofile,
# and ~/.zshrc. Source them explicitly so aliases / PATH / etc. still work.
[ -f "$HOME/.zshenv"   ] && source "$HOME/.zshenv"
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"
[ -f "$HOME/.zshrc"    ] && source "$HOME/.zshrc"

zmodload zsh/datetime 2>/dev/null
autoload -U add-zsh-hook

# Minimal prompt — Grove renders chips/context in its own UI
PS1='› '
RPROMPT=''

typeset -g _grove_t0

_grove_osc7() {
  local host="\${HOST:-localhost}"
  printf '\\e]7;file://%s%s\\e\\\\' "$host" "$PWD"
}

_grove_preexec() {
  _grove_t0=$EPOCHREALTIME
  _grove_osc7
  local b64
  b64=$(printf '%s' "$1" | base64 | tr -d '\\n')
  printf '\\e]133;C\\a'
  printf '\\e]1337;grove-pre;%s;%s\\a' "$b64" "$PWD"
}

_grove_precmd() {
  local exit=$?
  local dur=0
  if [[ -n $_grove_t0 ]]; then
    dur=$(( EPOCHREALTIME - _grove_t0 ))
    _grove_t0=""
  fi
  printf '\\e]133;D;%s\\a' "$exit"
  printf '\\e]1337;grove-post;%s;%s\\a' "$exit" "$dur"
  _grove_osc7
}

_grove_force_prompt() {
  PROMPT='› '
  PS1='› '
  RPROMPT=''
  RPS1=''
}

# Apply immediately in case theme already set it during sourcing
_grove_force_prompt

add-zsh-hook preexec _grove_preexec
add-zsh-hook precmd _grove_precmd
# Keep this LAST so it runs after starship/p10k/etc. precmd hooks
add-zsh-hook precmd _grove_force_prompt

# Emit initial cwd so the backend knows where we are at start
_grove_osc7

# Disable Powerlevel10k's instant prompt if active
typeset -g POWERLEVEL9K_INSTANT_PROMPT=off

# Initial marker so the first block has a valid start
_grove_force_prompt
printf '\\e]1337;grove-post;0;0\\a'
`;

export function ensureShellInitDir(): string {
  if (cachedDir && fs.existsSync(cachedDir)) return cachedDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-zsh-'));
  fs.writeFileSync(path.join(dir, '.zshrc'), ZSHRC, 'utf8');
  cachedDir = dir;
  return dir;
}
