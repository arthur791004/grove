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

# Force-load nvm (in case the user's setup lazy-defines it as a stub function).
# When loaded, \`node\` becomes a real binary in PATH so subshells and forks see
# the same version the user sees.
if [ -z "$NVM_DIR" ] && [ -d "$HOME/.nvm" ]; then
  export NVM_DIR="$HOME/.nvm"
fi
if [ -n "$NVM_DIR" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh" --no-use 2>/dev/null
  if command -v nvm >/dev/null 2>&1; then
    nvm use default >/dev/null 2>&1 || nvm use --silent default 2>/dev/null
  fi
fi

zmodload zsh/datetime 2>/dev/null
autoload -U add-zsh-hook

# Minimal prompt — Grove renders chips/context in its own UI
PS1='› '
RPROMPT=''
# Suppress zsh's "%" marker after commands whose output doesn't end with a
# newline. Useful in raw terminals; visual noise in our block UI.
PROMPT_EOL_MARK=''

# Disable git's pager (less) so output streams directly into the block —
# alt-screen pagers wipe their content on exit, which would leave the block
# empty. The block list is scrollable, so we don't lose the affordance.
export GIT_PAGER=cat
export PAGER=less
export LESS='-FRX'

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

_grove_emit_env() {
  local _gv_node _gv_branch _gv_venv _gv_conda _gv_aws _gv_tmp
  _gv_node=""
  _gv_branch=""
  _gv_venv=""
  _gv_conda=""
  _gv_aws=""
  _gv_tmp="/tmp/grove-env-$$"
  # Make sure nvm's bin is at the front of PATH so direct \`node\` calls and
  # forked processes (yarn, npm) all use the active nvm version.
  if [ -n "$NVM_BIN" ] && [[ "$PATH" != "$NVM_BIN:"* ]]; then
    PATH="$NVM_BIN:$PATH"
    export PATH
  fi
  if [ -n "$NVM_BIN" ] && [ -x "$NVM_BIN/node" ]; then
    "$NVM_BIN/node" -v >|"$_gv_tmp" 2>/dev/null
    read -r _gv_node <"$_gv_tmp" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then
    node -v >|"$_gv_tmp" 2>/dev/null
    read -r _gv_node <"$_gv_tmp" 2>/dev/null
  fi
  git symbolic-ref --short HEAD >|"$_gv_tmp" 2>/dev/null
  read -r _gv_branch <"$_gv_tmp" 2>/dev/null
  rm -f "$_gv_tmp"
  if [ -n "$VIRTUAL_ENV" ]; then
    _gv_venv="\${VIRTUAL_ENV##*/}"
  fi
  if [ -n "$CONDA_DEFAULT_ENV" ]; then
    _gv_conda="$CONDA_DEFAULT_ENV"
  fi
  if [ -n "$AWS_PROFILE" ]; then
    _gv_aws="$AWS_PROFILE"
  fi
  printf '\\e]1337;grove-env;node=%s|branch=%s|venv=%s|conda=%s|aws=%s\\a' "$_gv_node" "$_gv_branch" "$_gv_venv" "$_gv_conda" "$_gv_aws"
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
  _grove_emit_env
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
  if (!cachedDir || !fs.existsSync(cachedDir)) {
    cachedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-zsh-'));
  }
  // Rewrite the rc on every spawn rather than trusting the cached dir. The file
  // lives under /var/folders/.../T, which macOS reaps after a few days while a
  // long-running daemon keeps the (still-cached) directory alive — leaving
  // ZDOTDIR pointing at a dir with no .zshrc, so zsh loads no rc and the user's
  // ~/.zshrc (PATH, aliases) silently stops being sourced. Always writing it is
  // cheap (a few KB), self-heals after a reap, and avoids version drift if the
  // ZSHRC constant changes between builds.
  fs.writeFileSync(path.join(cachedDir, '.zshrc'), ZSHRC, 'utf8');
  return cachedDir;
}
