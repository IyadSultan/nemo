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

if menu then
    menu:setTitle("🧠")
    -- Left click the brain: open or focus. Right click: show the menu.
    menu:setClickCallback(openVoice)
    menu:setMenu({
        { title = "Open voice control", fn = openVoice },
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

openVoice()
