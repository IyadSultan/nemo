-- Hey my brain
-- A voice-control window, not a browser tab.
-- The green button uses the same live voice model as Nemo,
-- so it hears the microphone and talks back.
--
-- This window runs in its own Chrome profile so we can find it again.
-- Clicking the brain focuses that window if it is already open.

local PORT = "3001"
local VOICE_URL = "http://127.0.0.1:" .. PORT .. "/voice.html"
local CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
-- Separate from the user's normal Chrome, so this process is easy to spot.
local PROFILE = os.getenv("HOME") .. "/Library/Application Support/hey-my-brain-chrome"

-- One menu icon. Reload Config deletes the previous one first.
if _G.heyMyBrainMenu then
    _G.heyMyBrainMenu:delete()
    _G.heyMyBrainMenu = nil
end
local menu = hs.menubar.new()
_G.heyMyBrainMenu = menu

local function serverUp()
    local code = hs.execute("curl -s -o /dev/null -w '%{http_code}' --max-time 2 " .. VOICE_URL)
    return code and code:match("^200") ~= nil
end

-- PIDs for the dedicated brain Chrome (main process, not a helper).
local function brainPids()
    -- Match a folder name with no spaces, so the shell command stays simple.
    local out = hs.execute("/usr/bin/pgrep -f hey-my-brain-chrome") or ""
    local pids = {}
    for pid in out:gmatch("%d+") do
        local cmd = hs.execute("/bin/ps -p " .. pid .. " -o command=") or ""
        -- Helpers also mention the profile path. Keep only the main Chrome binary.
        if cmd:find("Google Chrome.app/Contents/MacOS/Google Chrome", 1, true)
            and not cmd:find("Helper", 1, true) then
            pids[#pids + 1] = tonumber(pid)
        end
    end
    return pids
end

-- Bring the existing brain Chrome to the front. True when one was found.
local function focusExistingVoice()
    for _, pid in ipairs(brainPids()) do
        local app = hs.application.applicationForPID(pid)
        if app then
            app:unhide()
            app:activate(true)
            local wins = app:allWindows()
            if wins and wins[1] then
                wins[1]:focus()
            end
            return true
        end
    end

    -- Older windows opened before the dedicated profile. Match by title when macOS allows it.
    for _, win in ipairs(hs.window.allWindows()) do
        local title = (win:title() or ""):lower()
        if title:find("hey my brain", 1, true) or title:find("voice.html", 1, true) then
            win:application():activate(true)
            win:focus()
            return true
        end
    end
    return false
end

local function openVoice()
    if not serverUp() then
        hs.alert.show("Voice app is not running. In Terminal: npm run brain", 4)
        return
    end
    if focusExistingVoice() then
        if menu then menu:setTitle("🧠") end
        return
    end

    -- First open (or after the window was closed). Own profile = one brain Chrome.
    hs.execute("mkdir -p " .. string.format("%q", PROFILE))
    hs.task.new(CHROME, nil, {
        "--user-data-dir=" .. PROFILE,
        "--no-first-run",
        "--no-default-browser-check",
        "--app=" .. VOICE_URL,
    }):start()
    if menu then menu:setTitle("🧠") end
end

-- Tell the open voice page to take the next sentence, the same as saying Hey.
local function startListening()
    hs.http.asyncPost("http://127.0.0.1:" .. PORT .. "/control/listen", "", nil, function(status)
        if status ~= 200 then hs.alert.show("Voice app is not running.", 2) end
    end)
end

-- Restart the server (launchd keeps it alive), then reopen the window so it loads the new page.
local function restartVoice()
    hs.alert.show("Restarting voice app…", 2)
    for _, pid in ipairs(brainPids()) do
        local app = hs.application.applicationForPID(pid)
        if app then app:kill() end
    end
    hs.execute("/bin/launchctl kickstart -k gui/$(id -u)/com.iyad.talk-to-your-brain")
    local tries = 0
    local timer
    timer = hs.timer.doEvery(1, function()
        tries = tries + 1
        if serverUp() then
            timer:stop()
            openVoice()
        elseif tries >= 30 then
            timer:stop()
            hs.alert.show("Voice app did not come back. See ~/Library/Logs/talk-to-your-brain/brain.err.log", 4)
        end
    end)
end

if menu then
    menu:setTitle("🧠")
    -- Left click the brain: open or focus. Right click: show the menu.
    menu:setClickCallback(openVoice)
    menu:setMenu({
        { title = "Open voice control", fn = openVoice },
        { title = "Start listening (⌘⌃)", fn = startListening },
        { title = "Restart voice app", fn = restartVoice },
    })
end

-- Cmd+Opt+S from any app: stop the answer that is playing.
-- The server passes it to the open voice page (/control).
if _G.heyMyBrainStopKey then _G.heyMyBrainStopKey:delete() end
_G.heyMyBrainStopKey = hs.hotkey.bind({ "cmd", "alt" }, "s", function()
    hs.http.asyncPost("http://127.0.0.1:" .. PORT .. "/control/stop", "", nil, function(status)
        if status ~= 200 then hs.alert.show("Voice app is not running.", 2) end
    end)
end)

-- Command and Control together, from any app: start listening. Saying Hey still works too.
-- Let go of both keys with no letter in between. Command–Control plus a letter
-- (read-aloud, the panel, the lock screen) is left alone, and Spotlight keeps Command–Space.
if _G.heyMyBrainListenKey then
    _G.heyMyBrainListenKey:delete()
    _G.heyMyBrainListenKey = nil
end
if _G.heyMyBrainListenTap then
    _G.heyMyBrainListenTap:stop()
    _G.heyMyBrainListenTap = nil
end

local commandControlDown = false
local commandControlUsed = false
-- These are the modifier keys themselves. Holding them is the shortcut, not a letter.
local modifierKey = {
    [54] = true, [55] = true, -- command
    [59] = true, [62] = true, -- control
    [56] = true, [60] = true, -- shift
    [58] = true, [61] = true, -- option
    [57] = true, [63] = true, -- caps lock, fn
}
_G.heyMyBrainListenTap = hs.eventtap.new({
    hs.eventtap.event.types.flagsChanged,
    hs.eventtap.event.types.keyDown,
}, function(event)
    -- A letter while both keys are held means a different shortcut. Do not listen.
    if event:getType() == hs.eventtap.event.types.keyDown then
        if commandControlDown and not modifierKey[event:getKeyCode()] then
            commandControlUsed = true
        end
        return false
    end

    local flags = event:getFlags()
    local both = flags.cmd and flags.ctrl and not flags.alt and not flags.shift
    if both then
        if not commandControlDown then
            commandControlDown = true
            commandControlUsed = false
        end
        return false
    end

    -- Shift or Option was added. This is a different shortcut.
    if commandControlDown and (flags.alt or flags.shift) then
        commandControlUsed = true
    end

    -- One of Command or Control was let go. Listen only if no other key was pressed.
    if commandControlDown and not (flags.cmd and flags.ctrl) then
        if not commandControlUsed then startListening() end
        commandControlDown = false
        commandControlUsed = false
    end
    return false
end)
_G.heyMyBrainListenTap:start()

openVoice()
