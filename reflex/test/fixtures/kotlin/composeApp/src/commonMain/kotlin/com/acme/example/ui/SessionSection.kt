// File: packages/acme-example/composeApp/src/commonMain/kotlin/com/acme/example/ui/SessionSection.kt
// Created At: 2026-08-25 23:30:00 +07:00
// Created By: AI
// AI Agent: Claude Code
// Model: claude-opus-5
// AI-GENERATED START: the session block at the top of Home — sign in, or refresh / sign out.
// This is where the Authentication module's Login tab moved to. It was one tab down inside one
// module, which put the app's own front door three taps from the front door of the harness; the
// question it answers — is this app signed in? — is the first thing every other module depends on,
// so it belongs above them.
//
// The walk runs in the popups of LoginDialogs.kt — phone (`checkUser`), the auth-switcher's method list
// and OTP screen, password (`login`) — and the stepper below the button is still the audit trail: one row
// per step, locked until the one before it answers, tappable to reopen that step's popup. What
// changed is when it is on screen — the rows appear once the walk has produced its first outcome
// and fold away again on "Bắt đầu lại", so a signed-out Home is a button rather than a form.
//
// Emitted into Home's LazyColumn as items rather than drawn as one block: a nested scroller inside
// a LazyColumn is unmeasurable, and the step rows are list rows like every other row on Home.
// No `com.acme.core` import — the session arrives as plain data (REVIEW.md §2.3).
package com.acme.example.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.acme.example.harness.LoginDialog
import com.acme.example.harness.LoginFlowState
import com.acme.example.harness.LoginStep
import com.acme.example.harness.SessionAction
import com.acme.example.harness.SessionState

/** Height every primary control in this block shares, so the two-button row reads as one control. */
private val ActionHeight = 50.dp

/**
 * Emits the session block into Home's list.
 *
 * [login] and [onLoginChange] are only read on the signed-out side, and [onSessionRun] only on the
 * signed-in one — the card never offers both, because the core is never in both states.
 */
fun LazyListScope.sessionSection(
    session: SessionState,
    login: LoginFlowState,
    onSessionRun: (SessionAction) -> Unit,
    onLoginChange: (LoginFlowState) -> Unit,
) {
    item(key = "session-card") {
        SessionCard(
            session = session,
            login = login,
            onSessionRun = onSessionRun,
            onLoginChange = onLoginChange,
        )
    }
    // The stepper is the audit trail of a walk in progress; before the first outcome there is
    // nothing to audit, and after "Bắt đầu lại" there is nothing again.
    if (session.isLogged || login.outcomes.isEmpty()) return
    items(LoginStep.entries, key = { "login-step-${it.name}" }) { step ->
        LoginStepCard(step = step, state = login, onChange = onLoginChange)
    }
    item(key = "login-reset") {
        OutlineButton(
            label = "Bắt đầu lại",
            enabled = !login.isBusy,
            onClick = { onLoginChange(login.reset()) },
        )
    }
}

@Composable
private fun SessionCard(
    session: SessionState,
    login: LoginFlowState,
    onSessionRun: (SessionAction) -> Unit,
    onLoginChange: (LoginFlowState) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().harnessCard().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SectionLabel(text = "PHIÊN ĐĂNG NHẬP")
        AuthStateStrip(session)
        if (session.isLogged) {
            SignedInActions(session = session, onRun = onSessionRun)
        } else {
            SignedOutAction(login = login, onChange = onLoginChange)
        }
        SessionAction.entries.forEach { action ->
            val outcome = session.outcomeOf(action) ?: return@forEach
            OutcomeBlock(
                isSuccess = outcome.isSuccess,
                summary = "${action.label} · ${outcome.summary}",
                detail = outcome.detail,
            )
        }
    }
}

/** What the core says right now: the state itself, and the token behind it when there is one. */
@Composable
private fun AuthStateStrip(session: SessionState) {
    val snapshot = session.snapshot
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            TagLabel(
                text = "authState: ${snapshot.authState.ifEmpty { "…" }}",
                background = if (session.isLogged) HarnessColors.accent2_200 else HarnessColors.neutral200,
                contentColor = if (session.isLogged) HarnessColors.accent2_800 else HarnessColors.neutral600,
                mono = true,
                fontSize = 10,
            )
            if (snapshot.hasToken) {
                TagLabel(
                    text = "token len=${snapshot.tokenLength}",
                    background = HarnessColors.accent200,
                    contentColor = HarnessColors.accent800,
                    mono = true,
                    fontSize = 10,
                )
            }
        }
        MonoText(
            text = if (session.isLogged) {
                "SessionCapability · ${snapshot.refreshStatus} · source=${snapshot.tokenSource.ifEmpty { "—" }}"
            } else {
                // AI-GENERATED START: bốn bước checkUser → switcher → login → token
                "chưa đăng nhập — checkUser → OTP (switcher) → login → token ngay tại đây"
                // AI-GENERATED END: bốn bước checkUser → switcher → login → token
            },
            fontSize = 10,
            color = HarnessColors.neutral500,
            maxLines = 2,
        )
        if (session.isLogged && snapshot.hasToken) {
            MonoText(text = snapshot.tokenPreview, fontSize = 10, color = HarnessColors.neutral600)
        }
    }
}

@Composable
private fun SignedInActions(session: SessionState, onRun: (SessionAction) -> Unit) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        ActionButton(
            label = "⟳ ${SessionAction.REFRESH_TOKEN.label}",
            background = HarnessColors.accent,
            contentColor = HarnessColors.neutral100,
            enabled = !session.isBusy,
            isBusy = session.busy == SessionAction.REFRESH_TOKEN,
            modifier = Modifier.weight(1.4f),
            onClick = { onRun(SessionAction.REFRESH_TOKEN) },
        )
        ActionButton(
            label = SessionAction.LOGOUT.label,
            background = HarnessColors.neutral200,
            contentColor = HarnessColors.accent800,
            enabled = !session.isBusy,
            isBusy = session.busy == SessionAction.LOGOUT,
            modifier = Modifier.weight(1f),
            onClick = { onRun(SessionAction.LOGOUT) },
        )
    }
    MonoText(
        text = "${SessionAction.REFRESH_TOKEN.cmd} · ${SessionAction.LOGOUT.cmd}",
        fontSize = 9,
        color = HarnessColors.neutral500,
        maxLines = 2,
    )
}

/** Opens the first popup. The whole walk runs from here, the way tapping "Đăng nhập" does. */
@Composable
private fun SignedOutAction(login: LoginFlowState, onChange: (LoginFlowState) -> Unit) {
    ActionButton(
        label = "Đăng nhập",
        background = HarnessColors.accent,
        contentColor = HarnessColors.neutral100,
        enabled = !login.isBusy,
        isBusy = login.isBusy,
        modifier = Modifier.fillMaxWidth(),
        onClick = { onChange(login.showing(LoginDialog.PHONE)) },
    )
}

@Composable
private fun ActionButton(
    label: String,
    background: Color,
    contentColor: Color,
    enabled: Boolean,
    isBusy: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Box(
        modifier = modifier
            .heightIn(min = ActionHeight)
            .background(if (enabled) background else HarnessColors.neutral300, HarnessShapes.pill)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (isBusy) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp), color = contentColor, strokeWidth = 2.5.dp)
        } else {
            Text(text = label, color = contentColor, fontSize = 13.5.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun OutlineButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = TouchTarget)
            .border(1.5.dp, HarnessColors.divider, HarnessShapes.pill)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = label, color = HarnessColors.neutral700, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
    }
}

// AI-GENERATED START: hàng OTP mở lại đúng màn switcher đang chờ
/** Which popup a given step reopens when its row is tapped. */
private fun dialogFor(step: LoginStep, state: LoginFlowState): LoginDialog = when (step) {
    LoginStep.PHONE -> LoginDialog.PHONE
    LoginStep.OTP -> state.otpDialog
    LoginStep.PIN -> LoginDialog.PIN
    LoginStep.TOKEN -> LoginDialog.RESULT
}
// AI-GENERATED END: hàng OTP mở lại đúng màn switcher đang chờ

/**
 * One row of the audit trail.
 *
 * The locking is a real constraint, not a UI nicety: genToken needs the riskId checkUser issued,
 * initOTP needs genToken's token, and login needs the device registration verifyOTP performs. Every
 * step names the v2 call it makes, so a red row can be matched against a server log.
 */
@Composable
private fun LoginStepCard(step: LoginStep, state: LoginFlowState, onChange: (LoginFlowState) -> Unit) {
    val unlocked = state.isUnlocked(step)
    val outcome = state.outcomeOf(step)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .harnessCard()
            .clickable(enabled = unlocked && !state.isBusy) {
                // AI-GENERATED START: hàng OTP mở lại đúng màn switcher đang chờ
                onChange(state.showing(dialogFor(step, state)))
                // AI-GENERATED END: hàng OTP mở lại đúng màn switcher đang chờ
            }
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StepBadge(
                index = step.ordinal + 1,
                isRunning = state.busy == step,
                isUnlocked = unlocked,
                isSuccess = outcome?.isSuccess,
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = step.label,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (unlocked) HarnessColors.text else HarnessColors.neutral500,
                )
                MonoText(text = step.cmd, fontSize = 10, color = HarnessColors.neutral500)
            }
        }
        if (!unlocked) {
            MonoText(
                text = "khoá — hoàn tất bước ${step.ordinal} trước",
                fontSize = 10,
                color = HarnessColors.neutral500,
            )
            return@Column
        }
        if (outcome == null) {
            MonoText(text = "chạm để mở popup bước này", fontSize = 10, color = HarnessColors.neutral500)
        } else {
            OutcomeBlock(outcome.isSuccess, outcome.summary, outcome.detail)
        }
    }
}

@Composable
private fun StepBadge(index: Int, isRunning: Boolean, isUnlocked: Boolean, isSuccess: Boolean?) {
    if (isRunning) {
        CircularProgressIndicator(
            modifier = Modifier.size(30.dp),
            color = HarnessColors.accent600,
            strokeWidth = 3.dp,
        )
        return
    }
    val background = when {
        isSuccess == true -> HarnessColors.accent2_200
        isSuccess == false -> HarnessColors.accent200
        isUnlocked -> HarnessColors.accent100
        else -> HarnessColors.neutral200
    }
    val content = when {
        isSuccess == true -> HarnessColors.accent2_800
        isSuccess == false -> HarnessColors.accent800
        isUnlocked -> HarnessColors.accent800
        else -> HarnessColors.neutral500
    }
    val glyph = when (isSuccess) {
        true -> "✓"
        false -> "✕"
        else -> index.toString()
    }
    Box(
        modifier = Modifier.size(30.dp).background(background, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = glyph, color = content, fontSize = 13.sp, fontWeight = FontWeight.ExtraBold)
    }
}

/** The verdict tag plus the dark payload panel, shared by a login step and a session action. */
@Composable
fun OutcomeBlock(isSuccess: Boolean, summary: String, detail: String) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TagLabel(
            text = "${if (isSuccess) "✓" else "✕"} $summary",
            background = if (isSuccess) HarnessColors.accent2_200 else HarnessColors.accent200,
            contentColor = if (isSuccess) HarnessColors.accent2_800 else HarnessColors.accent800,
            mono = true,
            fontSize = 10,
        )
        if (detail.isNotEmpty()) {
            MonoText(
                text = detail,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(HarnessColors.neutral900, HarnessShapes.small)
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                color = HarnessColors.neutral200,
                fontSize = 10,
                maxLines = 20,
                lineHeight = 15,
            )
        }
    }
}
// AI-GENERATED END: the session block at the top of Home — sign in, or refresh / sign out.
