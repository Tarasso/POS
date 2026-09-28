import { Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

const PIN_LENGTH = 4;

@Component({
  selector: 'app-login',
  standalone: true,
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  readonly digits = signal('');
  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);
  /** Bumped on each wrong PIN to retrigger the shake animation. */
  readonly shakeKey = signal(0);

  readonly dots = computed(() =>
    Array.from({ length: PIN_LENGTH }, (_, i) => i < this.digits().length)
  );
  /** Signed in with Microsoft, but that account was never invited. */
  readonly uninvitedUser = computed(() => {
    const s = this.auth.session();
    return s && !s.authenticated ? s.microsoftUser ?? null : null;
  });

  readonly keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];

  private readonly returnUrl = this.safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
  readonly microsoftLoginUrl = this.auth.microsoftLoginUrl(this.returnUrl);
  readonly switchAccountUrl =
    `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent('/login')}`;

  ngOnInit(): void {
    if (this.auth.isAuthenticated()) {
      this.router.navigateByUrl(this.returnUrl);
      return;
    }
    // Picks up a Microsoft session (e.g. returning from /.auth/login/aad) or a
    // still-valid guest cookie whose cached session was cleared.
    this.auth.refresh()
      .then(s => { if (s.authenticated) this.router.navigateByUrl(this.returnUrl); })
      .catch(() => { /* API unreachable — the PIN pad still works once it wakes */ });
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if (/^[0-9]$/.test(e.key)) this.press(e.key);
    else if (e.key === 'Backspace') this.press('⌫');
  }

  press(key: string): void {
    if (this.submitting() || !key) return;
    this.error.set(null);
    if (key === '⌫') {
      this.digits.update(d => d.slice(0, -1));
      return;
    }
    if (this.digits().length >= PIN_LENGTH) return;
    this.digits.update(d => d + key);
    if (this.digits().length === PIN_LENGTH) this.submit();
  }

  private submit(): void {
    this.submitting.set(true);
    this.auth.guestLogin(this.digits()).subscribe({
      next: () => {
        this.submitting.set(false);
        this.router.navigateByUrl(this.returnUrl);
      },
      error: (err: HttpErrorResponse) => {
        this.submitting.set(false);
        this.digits.set('');
        this.shakeKey.update(n => n + 1);
        this.error.set(this.messageFor(err));
      },
    });
  }

  private messageFor(err: HttpErrorResponse): string {
    switch (err.status) {
      case 401: return 'Incorrect PIN. Try again.';
      case 429: {
        const mins = Math.ceil((err.error?.retryAfterSeconds ?? 60) / 60);
        return `Too many incorrect tries. Try again in ${mins} min.`;
      }
      case 503: return 'Guest sign-in isn’t set up yet. Ask the owner.';
      case 0:   return 'Can’t reach the server. Check your connection.';
      default:  return 'Sign-in failed. Please try again.';
    }
  }

  /** Only allow same-app paths — never bounce to another site or back to /login. */
  private safeReturnUrl(url: string | null): string {
    if (!url || !url.startsWith('/') || url.startsWith('//') || url.startsWith('/login')) {
      return '/order';
    }
    return url;
  }
}
