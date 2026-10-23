// File: packages/acme-example/composeApp/src/commonMain/kotlin/com/acme/example/harness/LoginFlowModels.kt
// Created At: 2026-08-25 14:05:00 +07:00
// Created By: AI
// AI Agent: Claude Code
// Model: claude-opus-5
// AI-GENERATED START: đăng nhập qua auth-switcher của core dưới dạng state thuần cho UI
// Bốn bước, theo đúng thứ tự app thật:
//
//   PHONE  `IAuthenticationApi.checkUser` — thiết bị đã tin cậy thì trả luôn. Thiết bị mới thì backend
//          trả challenge 881200000 và auth-switcher của core giữ lời gọi đó lại, chờ host trả lời.
//   OTP    Switcher hỏi qua navigator của host: popup "chọn phương thức xác thực"; chọn OTP thì core
//          tự genToken + initOTP (**SMS/cuộc gọi thật**) và mở màn nhập OTP. Example đứng thay app ở cả
//          hai chỗ (`probe/ExampleNavigatorHost`): mã được xác thực bằng `verifyLoginOtp`, rồi trả
//          "success" cho switcher để nó gọi lại checkUser với risk-id — lần này qua.
//   PIN    `IAuthenticationApi.login` — chỉ tới được khi checkUser đã qua.
//   TOKEN  `ISessionApi.accessToken()` — token mà mọi caller khác nhận được.
//
// `beginLogin` của core-api không dùng được ở đây: nó cũng gọi checkUser qua switcher, nên trên thiết
// bị mới nó treo chờ đúng cái popup chỉ host vẽ được — và nó đòi mật khẩu trước khi có OTP.
// No `com.acme.core` import — the driver in `harness/probe/LoginFlowDriver` owns the seam.
package com.acme.example.harness

// AI-GENERATED START: the UAT test account is generated, never committed
// DEFAULT_TEST_PHONE / DEFAULT_TEST_PIN / DEFAULT_TEST_OTP prefill the popups so a tester can press
// straight through; anything typed replaces them. They live in the generated TestAccount.kt of this
// package, filled from the git-ignored local.properties — see "UAT test account" in the README.
// AI-GENERATED END: the UAT test account is generated, never committed

/** Switcher method code of the OTP option — the only method the example can finish without eKYC UI. */
const val REQUIRED_OTP_CODE: Int = 881200002

/** One screen of the login flow, with the call that step actually makes. */
enum class LoginStep(val label: String, val cmd: String) {
    PHONE(label = "Nhập số điện thoại", cmd = "IAuthenticationApi.checkUser"),
    OTP(label = "Chọn phương thức & nhập OTP", cmd = "auth-switcher · genToken · initOTP · verifyLoginOtp"),
    PIN(label = "Nhập mật khẩu", cmd = "IAuthenticationApi.login"),
    TOKEN(label = "Token sau đăng nhập", cmd = "ISessionApi.accessToken()"),
}

/**
 * Which Acme-style popup is on screen. The real app walks the login as a sequence of modals, and
 * the harness mirrors that: the stepper behind them is the audit trail, the popups are the flow.
 * [METHOD] and [OTP] are the two screens the switcher asks the host for.
 */
enum class LoginDialog { NONE, PHONE, METHOD, OTP, PIN, RESULT }

/**
 * One row of the "chọn phương thức xác thực" popup, as the switcher handed it to the host.
 *
 * [code] is the switcher method code ([REQUIRED_OTP_CODE] = OTP), [key] the optionKey genToken
 * needs, [otpType] the channel the backend suggested for it.
 */
data class LoginAuthOption(
    val code: Int,
    val key: String,
    val text: String,
    val subText: String = "",
    val otpType: String = "",
    val isEnabled: Boolean = true,
) {
    /** Only the OTP option can finish here: the others open eKYC / face screens the example lacks. */
    val isOtp: Boolean get() = code == REQUIRED_OTP_CODE
}

/**
 * What the switcher has asked so far. [options] fill the method popup; [otpType] is the channel the
 * backend actually used once [isOtpRequested]. [needsOtp] = false means checkUser passed with no
 * challenge — this device is already trusted, so the flow goes phone → password.
 */
data class LoginV2Session(
    val popupTitle: String = "",
    val popupDesc: String = "",
    val options: List<LoginAuthOption> = emptyList(),
    val chosen: LoginAuthOption? = null,
    val otpType: String = "",
    val isOtpRequested: Boolean = false,
    val needsOtp: Boolean = true,
) {
    /** The options the popup may actually offer — a disabled row is shown but not selectable. */
    val selectableOptions: List<LoginAuthOption> get() = options.filter { it.isEnabled }
}

/**
 * What one step returned. [summary] is the one-liner under the step, [detail] the full record, and
 * [session] — when present — replaces the flow's current [LoginV2Session].
 */
data class LoginStepOutcome(
    val isSuccess: Boolean,
    val summary: String,
    val detail: String = "",
    val session: LoginV2Session? = null,
)

/**
 * Every button in the flow. [advances] is whether success unlocks the next step: sending or
 * resending the OTP succeeds without completing its step, so it must not unlock the password.
 */
enum class LoginAction(val step: LoginStep, val label: String, val advances: Boolean) {
    CHECK_PHONE(step = LoginStep.PHONE, label = "Tiếp tục", advances = true),
    SEND_OTP(step = LoginStep.OTP, label = "Gửi mã", advances = false),
    RESEND_OTP(step = LoginStep.OTP, label = "Gửi lại mã", advances = false),
    VERIFY_OTP(step = LoginStep.OTP, label = "Xác nhận", advances = true),
    LOGIN(step = LoginStep.PIN, label = "Đăng nhập", advances = true),
    READ_TOKEN(step = LoginStep.TOKEN, label = "Đọc token", advances = false),
}

/** Signature the Home screen calls; the real implementation lives in `probe/LoginFlowDriver`. */
typealias LoginFlowCall = suspend (LoginAction, LoginFlowState) -> LoginStepOutcome

/**
 * Everything the login walk needs to survive recomposition.
 *
 * [reached] is the furthest step unlocked; [busy] is the step whose call is in flight, so the UI can
 * spin that one row and disable every button. [outcomes] keeps the last result per step, not per
 * action, because send, resend and verify share one row.
 */
data class LoginFlowState(
    val phone: String = "",
    val otp: String = "",
    val pin: String = "",
    val reached: LoginStep = LoginStep.PHONE,
    val busy: LoginStep? = null,
    val outcomes: Map<LoginStep, LoginStepOutcome> = emptyMap(),
    val session: LoginV2Session = LoginV2Session(),
    val dialog: LoginDialog = LoginDialog.NONE,
) {
    val isBusy: Boolean get() = busy != null

    /** The popup the OTP row reopens: the code entry once one was sent, the method list before. */
    val otpDialog: LoginDialog get() = if (session.isOtpRequested) LoginDialog.OTP else LoginDialog.METHOD

    fun isUnlocked(step: LoginStep): Boolean = step.ordinal <= reached.ordinal

    fun outcomeOf(step: LoginStep): LoginStepOutcome? = outcomes[step]

    fun starting(step: LoginStep): LoginFlowState = copy(busy = step)

    /**
     * Folds [outcome] into the state. Only a successful, step-completing action unlocks the next
     * step, so a wrong OTP cannot walk you onto the password. A checkUser that passed with no
     * challenge (trusted device) skips the OTP step, which would otherwise sit locked forever.
     */
    fun record(action: LoginAction, outcome: LoginStepOutcome): LoginFlowState {
        val next = outcome.session ?: session
        val unlocked = if (outcome.isSuccess && action.advances) {
            val target = if (action == LoginAction.CHECK_PHONE && !next.needsOtp) {
                LoginStep.PIN
            } else {
                nextOf(action.step)
            }
            maxOf(reached, target)
        } else {
            reached
        }
        return copy(
            busy = null,
            reached = unlocked,
            outcomes = outcomes + (action.step to outcome),
            session = next,
        )
    }

    fun showing(dialog: LoginDialog): LoginFlowState = copy(dialog = dialog)

    /** Records the method picked in the "chọn phương thức" popup; SEND_OTP hands it to the switcher. */
    fun choosing(option: LoginAuthOption): LoginFlowState = copy(session = session.copy(chosen = option))

    /**
     * Which popup follows a successful [action]; a failure keeps the popup where it is so the reason
     * stays on screen. After checkUser: the password on a trusted device, the OTP entry when the
     * switcher picked the method itself (it does when the backend hides the popup), else the list.
     */
    fun advanceDialog(action: LoginAction, outcome: LoginStepOutcome): LoginFlowState {
        if (!outcome.isSuccess) return this
        val after = outcome.session ?: session
        val next = when (action) {
            LoginAction.CHECK_PHONE -> when {
                !after.needsOtp -> LoginDialog.PIN
                after.isOtpRequested -> LoginDialog.OTP
                else -> LoginDialog.METHOD
            }
            LoginAction.SEND_OTP, LoginAction.RESEND_OTP -> LoginDialog.OTP
            LoginAction.VERIFY_OTP -> LoginDialog.PIN
            LoginAction.LOGIN -> LoginDialog.RESULT
            LoginAction.READ_TOKEN -> dialog
        }
        return copy(dialog = next)
    }

    // AI-GENERATED START: reset also restores the configured test OTP
    /** Back to the phone step, keeping the phone number and restoring the test password and OTP. */
    fun reset(): LoginFlowState = LoginFlowState(phone = phone, pin = DEFAULT_TEST_PIN, otp = DEFAULT_TEST_OTP)
    // AI-GENERATED END: reset also restores the configured test OTP

    private fun nextOf(step: LoginStep): LoginStep =
        LoginStep.entries.getOrElse(step.ordinal + 1) { step }
}
// AI-GENERATED END: đăng nhập qua auth-switcher của core dưới dạng state thuần cho UI
